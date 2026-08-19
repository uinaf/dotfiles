#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { readProfileModel, requireProfile, type SkillLayer } from "../profiles/model.ts";
import { readLockFile, writeLockFile } from "./lock.ts";
import {
  createRuntime,
  errorMessage,
  resolveProfileName,
  type Runtime,
  sanitizeDiagnostic,
  writeLine,
} from "./runtime.ts";

// `owner/repo` as accepted by the marketplace-add subcommands.
const MARKETPLACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function isSafeName(value: string): boolean {
  return NAME_PATTERN.test(value) && !RESERVED_NAMES.has(value);
}

// Claude must precede cursor and opencode: their skill links resolve into the
// Claude marketplace checkout that Claude's own sync creates and updates.
export const HARNESSES = ["claude", "codex", "cursor", "grok", "opencode"] as const;

export type Harness = (typeof HARNESSES)[number];

// How Cursor installs a plugin: through its marketplace and the interactive
// /plugins flow, or by linking standard skill directories into Cursor's
// native discovery path when team policy blocks third-party imports.
export type CursorMode = "marketplace" | "skills";

export type Plugin = {
  marketplace: string;
  marketplaceId: string;
  name: string;
  harnesses: readonly Harness[];
  cursorMode: CursorMode;
};

// Native skill discovery paths, relative to HOME, per link-capable harness.
const SKILL_LINK_ROOTS = {
  cursor: [".cursor", "skills"],
  opencode: [".config", "opencode", "skills"],
} as const;

export type PlannedCommand = {
  command: string;
  args: readonly string[];
  // Set on install commands whose harness installs a whole marketplace repository,
  // so apply can skip sources its CLI already lists.
  marketplace?: string;
  plugin?: string;
  // Refresh commands must not run after their marketplace add or plugin install failed.
  refresh?: boolean;
};

type PluginFailure = {
  diagnostic: string;
  summary: string;
};

type HarnessSpec = {
  binary: string;
  label: string;
  marketplaceArgs?(plugin: Plugin): string[];
  // Codex refreshes Git marketplace snapshots by configured name, not plugin ref.
  upgradeMarketplaceArgs?(plugin: Plugin): string[];
  // Cursor exposes no non-interactive install subcommand; installation happens via /plugins.
  installArgs?(plugin: Plugin): string[];
  // `--update` refreshes an already-installed plugin. Claude needs `-y` because
  // apply captures stdout and is therefore not a TTY.
  updateArgs?(plugin: Plugin): string[];
  // Grok installs a source repository once, not a plugin ref, and re-installing
  // an installed source exits non-zero; apply consults `plugin list` first.
  installsMarketplace?: {
    listArgs: readonly string[];
    installed(listOutput: string, plugin: Plugin): boolean;
  };
  // OpenCode has no compatible plugin format; apply links the Claude checkout's
  // skills into OpenCode's native skill discovery instead of running commands.
  linksClaudeSkills?: boolean;
};

const HARNESS_SPECS: Record<Harness, HarnessSpec> = {
  claude: {
    binary: "claude",
    label: "Claude Code",
    marketplaceArgs: (plugin) => ["plugin", "marketplace", "add", plugin.marketplace],
    installArgs: (plugin) => ["plugin", "install", pluginRef(plugin)],
    updateArgs: (plugin) => ["plugin", "update", pluginRef(plugin), "-y"],
  },
  codex: {
    binary: "codex",
    label: "Codex",
    marketplaceArgs: (plugin) => ["plugin", "marketplace", "add", plugin.marketplace],
    upgradeMarketplaceArgs: (plugin) => ["plugin", "marketplace", "upgrade", plugin.marketplaceId],
    installArgs: (plugin) => ["plugin", "add", pluginRef(plugin)],
  },
  cursor: {
    binary: "cursor-agent",
    label: "Cursor",
    marketplaceArgs: (plugin) => ["plugin", "marketplace", "add", `github.com/${plugin.marketplace}`],
  },
  grok: {
    binary: "grok",
    label: "Grok",
    installArgs: (plugin) => ["plugin", "install", plugin.marketplace, "--trust"],
    updateArgs: (plugin) => ["plugin", "update", plugin.name],
    installsMarketplace: {
      listArgs: ["plugin", "list"],
      installed: (listOutput, plugin) =>
        listOutput.includes(`git: https://github.com/${plugin.marketplace}]`),
    },
  },
  opencode: {
    binary: "opencode",
    label: "OpenCode",
    linksClaudeSkills: true,
  },
};

export function pluginRef(plugin: Plugin): string {
  return `${plugin.name}@${plugin.marketplaceId}`;
}

function isHarness(value: unknown): value is Harness {
  return typeof value === "string" && (HARNESSES as readonly string[]).includes(value);
}

function readHarnesses(value: unknown, manifestPath: string, name: string): readonly Harness[] {
  if (value === undefined) {
    return HARNESSES;
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(isHarness) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(
      `Invalid plugins manifest at ${manifestPath}: ${name} harnesses must be a unique non-empty subset of ${HARNESSES.join(", ")}`,
    );
  }
  // Selection uses membership, never order; normalize so composition compares
  // manifests by meaning rather than authoring order.
  return HARNESSES.filter((harness) => value.includes(harness));
}

function readPlugin(value: unknown, manifestPath: string): Plugin {
  if (
    typeof value !== "object" ||
    value === null ||
    !("marketplace" in value) ||
    typeof value.marketplace !== "string" ||
    !MARKETPLACE_PATTERN.test(value.marketplace) ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !isSafeName(value.name)
  ) {
    throw new Error(
      `Invalid plugins manifest at ${manifestPath}: expected owner/repo marketplace and safe plugin name strings`,
    );
  }

  const repository = value.marketplace.split("/")[1] ?? "";
  // Harnesses register a marketplace under the name its manifest declares, which is the
  // repository name for every marketplace we ship; `marketplaceId` overrides the divergent case.
  const marketplaceId =
    "marketplaceId" in value && value.marketplaceId !== undefined ? value.marketplaceId : repository;
  if (typeof marketplaceId !== "string" || !isSafeName(marketplaceId)) {
    throw new Error(
      `Invalid plugins manifest at ${manifestPath}: ${value.name} marketplaceId must be a safe name`,
    );
  }

  const harnesses = readHarnesses(
    "harnesses" in value ? value.harnesses : undefined,
    manifestPath,
    value.name,
  );
  if (harnesses.includes("opencode") && !harnesses.includes("claude")) {
    throw new Error(
      `Invalid plugins manifest at ${manifestPath}: ${value.name} targets opencode without claude; the OpenCode skill links resolve the Claude marketplace checkout`,
    );
  }

  const cursorMode =
    "cursorMode" in value && value.cursorMode !== undefined ? value.cursorMode : "marketplace";
  if (cursorMode !== "marketplace" && cursorMode !== "skills") {
    throw new Error(
      `Invalid plugins manifest at ${manifestPath}: ${value.name} cursorMode must be "marketplace" or "skills"`,
    );
  }
  if (cursorMode === "skills" && (!harnesses.includes("cursor") || !harnesses.includes("claude"))) {
    throw new Error(
      `Invalid plugins manifest at ${manifestPath}: ${value.name} sets cursorMode "skills" without targeting cursor and claude; the Cursor skill links resolve the Claude marketplace checkout`,
    );
  }

  return { marketplace: value.marketplace, marketplaceId, name: value.name, harnesses, cursorMode };
}

export function readPlugins(manifestPath: string): Plugin[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid plugins manifest at ${manifestPath}: ${errorMessage(error)}`);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("plugins" in parsed) ||
    !Array.isArray(parsed.plugins)
  ) {
    throw new Error(`Invalid plugins manifest at ${manifestPath}: expected a plugins array`);
  }

  const plugins = parsed.plugins.map((plugin) => readPlugin(plugin, manifestPath));
  const refs = new Set<string>();
  for (const plugin of plugins) {
    const ref = pluginRef(plugin);
    if (refs.has(ref)) {
      throw new Error(`Invalid plugins manifest at ${manifestPath}: ${ref} is defined more than once`);
    }
    refs.add(ref);
  }
  return plugins;
}

export function readLayeredPlugins(
  repoDir: string,
  profile: string,
  layers: readonly SkillLayer[],
): { layers: readonly SkillLayer[]; plugins: Plugin[] } {
  if (layers.length === 0) {
    throw new Error(`Profile ${profile} does not manage agent plugins`);
  }

  const manifests = new Map<SkillLayer, Plugin[]>();
  for (const layer of ["developer", "workstation", "devbox", "personal"] as const) {
    manifests.set(
      layer,
      readPlugins(join(repoDir, "scripts", "agents", "plugins", `${layer}.json`)),
    );
  }

  const seen = new Map<string, string>();
  const plugins: Plugin[] = [];
  for (const plugin of layers.flatMap((layer) => manifests.get(layer) ?? [])) {
    const ref = pluginRef(plugin);
    const shape = JSON.stringify(plugin);
    const previous = seen.get(ref);
    if (previous === shape) {
      continue; // the same plugin selected by more than one composed layer
    }
    if (previous !== undefined) {
      throw new Error(`Invalid layered plugins: ${ref} is defined more than once`);
    }
    seen.set(ref, shape);
    plugins.push(plugin);
  }

  return { layers, plugins };
}

type PluginLock = {
  version: 1;
  plugins: Plugin[];
};

function readLockedHarnesses(value: unknown, lockPath: string, name: string): readonly Harness[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(isHarness) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(
      `Invalid managed plugins lock at ${lockPath}: ${name} harnesses must be an explicit unique non-empty subset of ${HARNESSES.join(", ")}`,
    );
  }
  return HARNESSES.filter((harness) => value.includes(harness));
}

function readLockedPlugin(value: unknown, lockPath: string): Plugin {
  if (
    typeof value !== "object" ||
    value === null ||
    !("marketplace" in value) ||
    typeof value.marketplace !== "string" ||
    !MARKETPLACE_PATTERN.test(value.marketplace) ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !isSafeName(value.name) ||
    !("marketplaceId" in value) ||
    typeof value.marketplaceId !== "string" ||
    !isSafeName(value.marketplaceId) ||
    !("cursorMode" in value) ||
    (value.cursorMode !== "marketplace" && value.cursorMode !== "skills") ||
    !("harnesses" in value)
  ) {
    throw new Error(
      `Invalid managed plugins lock at ${lockPath}: expected explicit marketplace, marketplaceId, name, cursorMode, and harnesses`,
    );
  }

  return {
    marketplace: value.marketplace,
    marketplaceId: value.marketplaceId,
    name: value.name,
    cursorMode: value.cursorMode,
    harnesses: readLockedHarnesses(value.harnesses, lockPath, value.name),
  };
}

function readPluginLock(lockPath: string): Plugin[] | undefined {
  const parsed = readLockFile(lockPath, "plugins");
  if (parsed === undefined) {
    return undefined;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("plugins" in parsed) ||
    !Array.isArray(parsed.plugins)
  ) {
    throw new Error(
      `Invalid managed plugins lock at ${lockPath}: expected version 1 and a plugins array`,
    );
  }

  const plugins = parsed.plugins.map((plugin) => readLockedPlugin(plugin, lockPath));
  const refs = plugins.map(pluginRef);
  if (new Set(refs).size !== refs.length) {
    throw new Error(`Invalid managed plugins lock at ${lockPath}: plugin refs must be unique`);
  }
  return plugins;
}

function writePluginLock(lockPath: string, plugins: readonly Plugin[]): void {
  const lock: PluginLock = { version: 1, plugins: [...plugins] };
  writeLockFile(lockPath, lock);
}

function stalePlugins(previous: readonly Plugin[], current: readonly Plugin[]): Plugin[] {
  const currentByRef = new Map(current.map((plugin) => [pluginRef(plugin), plugin]));
  const stale: Plugin[] = [];

  for (const owned of previous) {
    const next = currentByRef.get(pluginRef(owned));
    if (next === undefined) {
      stale.push(owned);
      continue;
    }
    const dropped = owned.harnesses.filter((harness) => !next.harnesses.includes(harness));
    if (
      owned.cursorMode === "marketplace" &&
      next.cursorMode === "skills" &&
      owned.harnesses.includes("cursor") &&
      next.harnesses.includes("cursor") &&
      !dropped.includes("cursor")
    ) {
      dropped.push("cursor");
    }
    if (dropped.length > 0) {
      stale.push({ ...owned, harnesses: dropped, cursorMode: owned.cursorMode });
    }
  }

  return stale;
}

function appliedPlugins(runtime: Runtime, plugins: readonly Plugin[]): Plugin[] {
  return plugins
    .map((plugin) => ({
      ...plugin,
      harnesses: plugin.harnesses.filter((harness) =>
        runtime.commandExists(HARNESS_SPECS[harness].binary),
      ),
    }))
    .filter((plugin) => plugin.harnesses.length > 0);
}

function retainAbsentPlugins(
  runtime: Runtime,
  previous: readonly Plugin[],
  current: readonly Plugin[],
): Plugin[] {
  const currentByRef = new Map(current.map((plugin) => [pluginRef(plugin), plugin]));
  const leftover: Plugin[] = [];

  for (const owned of previous) {
    const next = currentByRef.get(pluginRef(owned));
    if (next === undefined) {
      continue;
    }
    const absent = owned.harnesses.filter(
      (harness) =>
        next.harnesses.includes(harness) && !runtime.commandExists(HARNESS_SPECS[harness].binary),
    );
    if (absent.length > 0) {
      leftover.push({ ...owned, harnesses: absent });
    }
  }

  return leftover;
}

function mergePluginLock(current: readonly Plugin[], leftover: readonly Plugin[]): Plugin[] {
  const byRef = new Map(
    current.map((plugin) => [pluginRef(plugin), { ...plugin, harnesses: [...plugin.harnesses] }]),
  );

  for (const extra of leftover) {
    const existing = byRef.get(pluginRef(extra));
    if (existing === undefined) {
      byRef.set(pluginRef(extra), extra);
      continue;
    }
    existing.harnesses = HARNESSES.filter(
      (harness) => existing.harnesses.includes(harness) || extra.harnesses.includes(harness),
    );
    if (extra.harnesses.includes("cursor")) {
      existing.cursorMode = extra.cursorMode;
    }
  }

  return [...byRef.values()];
}

function uninstallArgs(harness: Harness, plugin: Plugin): string[] | undefined {
  switch (harness) {
    case "claude":
      return ["plugin", "uninstall", "-y", pluginRef(plugin)];
    case "codex":
      return ["plugin", "remove", pluginRef(plugin)];
    case "grok":
      return ["plugin", "uninstall", plugin.name, "--confirm"];
    case "cursor":
    case "opencode":
      return undefined;
  }
}

function harnessPresent(runtime: Runtime): boolean {
  return HARNESSES.some((harness) => runtime.commandExists(HARNESS_SPECS[harness].binary));
}

function removeStalePlugins(
  runtime: Runtime,
  stale: readonly Plugin[],
  failures: PluginFailure[],
): Plugin[] {
  const leftover: Plugin[] = [];

  for (const plugin of stale) {
    const leftoverHarnesses: Harness[] = [];
    for (const harness of plugin.harnesses) {
      const spec = HARNESS_SPECS[harness];
      if (!runtime.commandExists(spec.binary)) {
        leftoverHarnesses.push(harness);
        writeLine(
          runtime.stdout,
          `Skipping ${spec.label} plugin removal: '${spec.binary}' is not installed`,
        );
        continue;
      }

      const args = uninstallArgs(harness, plugin);
      if (args === undefined) {
        if (harness === "cursor" && plugin.cursorMode === "marketplace") {
          leftoverHarnesses.push(harness);
          writeLine(
            runtime.stdout,
            `${spec.label} plugin removal is interactive; disable ${pluginRef(plugin)} in /plugins`,
          );
        }
        continue;
      }

      writeLine(runtime.stdout, `Removing stale managed plugin: ${pluginRef(plugin)} from ${spec.label}`);
      const result = runtime.run(spec.binary, args, { stdout: "capture", stderr: "capture" });
      if (result.status !== 0) {
        leftoverHarnesses.push(harness);
        failures.push({
          diagnostic: sanitizeDiagnostic(`${result.stdout}\n${result.stderr}`),
          summary: `${spec.label}: ${args.join(" ")} (exit ${result.status})`,
        });
      }
    }

    if (leftoverHarnesses.length > 0) {
      leftover.push({ ...plugin, harnesses: leftoverHarnesses });
    }
  }

  return leftover;
}

export function planHarness(
  harness: Harness,
  plugins: readonly Plugin[],
  options: { update?: boolean } = {},
): PlannedCommand[] {
  const spec = HARNESS_SPECS[harness];
  let selected = plugins.filter((plugin) => plugin.harnesses.includes(harness));
  if (harness === "cursor") {
    // Native-skills plugins install through skill links, never marketplace commands.
    selected = selected.filter((plugin) => plugin.cursorMode !== "skills");
  }
  const planned: PlannedCommand[] = [];
  const marketplaces = new Set<string>();

  const marketplaceArgs = spec.marketplaceArgs;
  if (marketplaceArgs !== undefined) {
    for (const plugin of selected) {
      if (marketplaces.has(plugin.marketplace)) {
        continue;
      }
      marketplaces.add(plugin.marketplace);
      planned.push({
        command: spec.binary,
        args: marketplaceArgs(plugin),
        marketplace: plugin.marketplace,
      });
      if (options.update === true && spec.upgradeMarketplaceArgs !== undefined) {
        planned.push({
          command: spec.binary,
          args: spec.upgradeMarketplaceArgs(plugin),
          marketplace: plugin.marketplace,
          refresh: true,
        });
      }
    }
  }

  const installArgs = spec.installArgs;
  if (installArgs === undefined) {
    return planned;
  }

  if (spec.installsMarketplace !== undefined) {
    const installed = new Set<string>();
    for (const plugin of selected) {
      if (installed.has(plugin.marketplace)) {
        continue;
      }
      installed.add(plugin.marketplace);
      planned.push({
        command: spec.binary,
        args: installArgs(plugin),
        marketplace: plugin.marketplace,
      });
    }
    return planned;
  }

  for (const plugin of selected) {
    planned.push({
      command: spec.binary,
      args: installArgs(plugin),
      marketplace: plugin.marketplace,
      plugin: pluginRef(plugin),
    });
  }

  if (options.update === true && spec.updateArgs !== undefined) {
    for (const plugin of selected) {
      planned.push({
        command: spec.binary,
        args: spec.updateArgs(plugin),
        marketplace: plugin.marketplace,
        plugin: pluginRef(plugin),
        refresh: true,
      });
    }
  }

  return planned;
}

function claudeMarketplacesRoot(home: string): string {
  return join(home, ".claude", "plugins", "marketplaces");
}

function marketplaceIds(plugins: readonly Plugin[]): Set<string> {
  return new Set(plugins.map((plugin) => plugin.marketplaceId));
}

function ownedMarketplaceTarget(
  home: string,
  linkPath: string,
  target: string,
  ownedMarketplaceIds: ReadonlySet<string>,
): boolean {
  const resolved = resolve(dirname(linkPath), target);
  const managedRoot = resolve(claudeMarketplacesRoot(home)) + sep;
  if (!resolved.startsWith(managedRoot)) {
    return false;
  }
  const marketplaceId = resolved.slice(managedRoot.length).split(sep)[0];
  return marketplaceId !== undefined && ownedMarketplaceIds.has(marketplaceId);
}

// Removes links that point at a previously owned Claude marketplace checkout
// and are dangling or no longer a planned target: a skill removed upstream, a
// deselected marketplace, or a plugin that left native-skills mode.
function removeStaleSkillLinks(
  home: string,
  linkRoot: string,
  keep: ReadonlySet<string>,
  ownedMarketplaceIds: ReadonlySet<string>,
): number {
  if (!existsSync(linkRoot)) {
    return 0;
  }

  let removed = 0;
  for (const entry of readdirSync(linkRoot)) {
    const linkPath = join(linkRoot, entry);
    if (!lstatSync(linkPath).isSymbolicLink()) {
      continue;
    }
    const target = readlinkSync(linkPath);
    if (!ownedMarketplaceTarget(home, linkPath, target, ownedMarketplaceIds)) {
      continue;
    }
    const resolved = resolve(dirname(linkPath), target);
    if (keep.has(resolved) && existsSync(linkPath)) {
      continue;
    }
    unlinkSync(linkPath);
    removed += 1;
  }
  return removed;
}

function linkClaudeSkills(
  runtime: Runtime,
  label: string,
  selected: readonly Plugin[],
  failures: PluginFailure[],
  rootSegments: readonly string[],
  pruneLinks: boolean,
  ownedMarketplaceIds: ReadonlySet<string>,
): void {
  const home = runtime.env.HOME;
  if (!home) {
    failures.push({
      diagnostic: `HOME is required to link ${label} skills`,
      summary: `${label}: skill links (missing HOME)`,
    });
    return;
  }

  const linkRoot = join(home, ...rootSegments);
  const linkedMarketplaces = new Set<string>();
  for (const plugin of selected) {
    if (linkedMarketplaces.has(plugin.marketplaceId)) {
      continue; // plugins from one marketplace repository share a checkout
    }
    linkedMarketplaces.add(plugin.marketplaceId);
    const source = join(claudeMarketplacesRoot(home), plugin.marketplaceId, "skills");
    if (!existsSync(source)) {
      failures.push({
        diagnostic: `${source} is missing; the Claude Code plugin sync creates it`,
        summary: `${label}: link ${pluginRef(plugin)} skills (missing Claude checkout)`,
      });
      continue;
    }

    mkdirSync(linkRoot, { recursive: true });
    let linked = 0;
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (!entry.isDirectory() || !existsSync(join(source, entry.name, "SKILL.md"))) {
        continue;
      }
      const target = join(source, entry.name);
      const linkPath = join(linkRoot, entry.name);
      // lstat instead of exists: a dangling symlink still occupies the path.
      const existing = lstatSync2(linkPath);
      if (existing !== undefined) {
        if (!existing.isSymbolicLink()) {
          failures.push({
            diagnostic: `${linkPath} exists and is not a symlink; move it aside to let sync manage it`,
            summary: `${label}: link ${entry.name} (conflicting entry)`,
          });
          continue;
        }
        const currentTarget = readlinkSync(linkPath);
        if (currentTarget === target) {
          linked += 1;
          continue;
        }
        if (
          !pruneLinks ||
          !ownedMarketplaceTarget(home, linkPath, currentTarget, ownedMarketplaceIds) ||
          !ownedMarketplaceTarget(home, linkPath, target, ownedMarketplaceIds)
        ) {
          failures.push({
            diagnostic: `${linkPath} points at ${currentTarget}, which sync does not manage; move it aside to let sync manage it`,
            summary: `${label}: link ${entry.name} (conflicting entry)`,
          });
          continue;
        }
        unlinkSync(linkPath);
      }
      symlinkSync(target, linkPath);
      linked += 1;
    }
    writeLine(
      runtime.stdout,
      `${label}: linked ${linked} ${plugin.marketplaceId} skills into ${linkRoot}`,
    );
  }
}

function plannedSkillTargets(home: string, plugins: readonly Plugin[]): Set<string> {
  const targets = new Set<string>();
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (seen.has(plugin.marketplaceId)) {
      continue;
    }
    seen.add(plugin.marketplaceId);
    const source = join(claudeMarketplacesRoot(home), plugin.marketplaceId, "skills");
    if (!existsSync(source)) {
      continue;
    }
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (!entry.isDirectory() || !existsSync(join(source, entry.name, "SKILL.md"))) {
        continue;
      }
      targets.add(resolve(join(source, entry.name)));
    }
  }
  return targets;
}

function pruneNativeSkillLinks(
  runtime: Runtime,
  plugins: readonly Plugin[],
  previous: readonly Plugin[],
): void {
  const home = runtime.env.HOME;
  if (!home) {
    return;
  }

  const owned = marketplaceIds(previous);
  const jobs = [
    {
      binary: HARNESS_SPECS.opencode.binary,
      label: HARNESS_SPECS.opencode.label,
      root: SKILL_LINK_ROOTS.opencode,
      selected: plugins.filter((plugin) => plugin.harnesses.includes("opencode")),
    },
    {
      binary: HARNESS_SPECS.cursor.binary,
      label: HARNESS_SPECS.cursor.label,
      root: SKILL_LINK_ROOTS.cursor,
      selected: plugins.filter(
        (plugin) => plugin.harnesses.includes("cursor") && plugin.cursorMode === "skills",
      ),
    },
  ] as const;

  for (const job of jobs) {
    if (!runtime.commandExists(job.binary)) {
      continue;
    }
    const removed = removeStaleSkillLinks(
      home,
      join(home, ...job.root),
      plannedSkillTargets(home, job.selected),
      owned,
    );
    if (removed > 0) {
      writeLine(runtime.stdout, `${job.label}: removed ${removed} stale managed skill links`);
    }
  }
}

// lstat that reports a dangling symlink (existsSync follows links and misses it).
function lstatSync2(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function grokListedPluginName(listOutput: string, plugin: Plugin): string | undefined {
  return listOutput.includes(`: ${plugin.name} [git: https://github.com/${plugin.marketplace}]`)
    ? plugin.name
    : undefined;
}

function refreshInstalledMarketplace(
  runtime: Runtime,
  spec: HarnessSpec,
  selected: readonly Plugin[],
  marketplace: string,
  listOutput: string,
  failures: PluginFailure[],
): void {
  const names = [
    ...new Set(
      selected
        .filter((plugin) => plugin.marketplace === marketplace)
        .map((plugin) => grokListedPluginName(listOutput, plugin))
        .filter((name): name is string => name !== undefined),
    ),
  ];
  if (names.length === 0) {
    failures.push({
      diagnostic: `${marketplace} is already installed, but Grok did not report a managed plugin name to update`,
      summary: `${spec.label}: ${marketplace} could not be refreshed`,
    });
    return;
  }

  const updateArgs = spec.updateArgs;
  if (updateArgs === undefined) {
    failures.push({
      diagnostic: `${marketplace} is already installed, and ${spec.label} has no non-interactive update command`,
      summary: `${spec.label}: ${marketplace} could not be refreshed`,
    });
    return;
  }

  for (const name of names) {
    const plugin = selected.find(
      (candidate) => candidate.marketplace === marketplace && candidate.name === name,
    );
    if (plugin === undefined) {
      continue;
    }
    const args = updateArgs(plugin);
    writeLine(runtime.stdout, `${spec.label}: ${spec.binary} ${args.join(" ")}`);
    const result = runtime.run(spec.binary, args, { stdout: "capture", stderr: "capture" });
    if (result.status !== 0) {
      failures.push({
        diagnostic: sanitizeDiagnostic(`${result.stdout}\n${result.stderr}`),
        summary: `${spec.label}: ${args.join(" ")} (exit ${result.status})`,
      });
    }
  }
}

function applyHarness(
  runtime: Runtime,
  harness: Harness,
  plugins: readonly Plugin[],
  failures: PluginFailure[],
  pruneLinks: boolean,
  ownedMarketplaceIds: ReadonlySet<string>,
  update: boolean,
): void {
  const spec = HARNESS_SPECS[harness];
  const selected = plugins.filter((plugin) => plugin.harnesses.includes(harness));

  if (!runtime.commandExists(spec.binary)) {
    writeLine(runtime.stdout, `Skipping ${spec.label} plugins: '${spec.binary}' is not installed`);
    return;
  }

  if (spec.linksClaudeSkills === true) {
    linkClaudeSkills(
      runtime,
      spec.label,
      selected,
      failures,
      SKILL_LINK_ROOTS.opencode,
      pruneLinks,
      ownedMarketplaceIds,
    );
    return;
  }

  let commandSelected = selected;
  if (harness === "cursor") {
    // Native-skills plugins bypass the blocked marketplace import entirely;
    // linking also prunes links left behind by a plugin that changed mode.
    const nativeSkills = selected.filter((plugin) => plugin.cursorMode === "skills");
    commandSelected = selected.filter((plugin) => plugin.cursorMode === "marketplace");
    linkClaudeSkills(
      runtime,
      spec.label,
      nativeSkills,
      failures,
      SKILL_LINK_ROOTS.cursor,
      pruneLinks,
      ownedMarketplaceIds,
    );
    if (commandSelected.length === 0) {
      if (selected.length === 0) {
        writeLine(runtime.stdout, `No ${spec.label} plugins are selected for this profile`);
      }
      return;
    }
  }

  if (selected.length === 0) {
    writeLine(runtime.stdout, `No ${spec.label} plugins are selected for this profile`);
    return;
  }

  let installedSources = "";
  const guard = spec.installsMarketplace;
  if (guard !== undefined) {
    const listed = runtime.run(spec.binary, [...guard.listArgs], {
      stdout: "capture",
      stderr: "capture",
    });
    if (listed.status !== 0) {
      failures.push({
        diagnostic: sanitizeDiagnostic(`${listed.stdout}\n${listed.stderr}`),
        summary: `${spec.label}: ${guard.listArgs.join(" ")} (exit ${listed.status})`,
      });
      return;
    }
    installedSources = listed.stdout;
  }

  const blockedMarketplaces = new Set<string>();
  const blockedPlugins = new Set<string>();
  for (const planned of planHarness(harness, plugins, { update })) {
    if (
      planned.refresh === true &&
      ((planned.marketplace !== undefined && blockedMarketplaces.has(planned.marketplace)) ||
        (planned.plugin !== undefined && blockedPlugins.has(planned.plugin)))
    ) {
      continue;
    }
    if (guard !== undefined && planned.marketplace !== undefined) {
      const plugin = selected.find((candidate) => candidate.marketplace === planned.marketplace);
      if (plugin !== undefined && guard.installed(installedSources, plugin)) {
        if (update) {
          refreshInstalledMarketplace(
            runtime,
            spec,
            selected,
            planned.marketplace,
            installedSources,
            failures,
          );
          continue;
        }
        writeLine(runtime.stdout, `${spec.label}: ${planned.marketplace} is already installed`);
        continue;
      }
    }
    writeLine(runtime.stdout, `${spec.label}: ${planned.command} ${planned.args.join(" ")}`);
    const result = runtime.run(planned.command, planned.args, {
      stdout: "capture",
      stderr: "capture",
    });
    if (result.status !== 0) {
      failures.push({
        diagnostic: sanitizeDiagnostic(`${result.stdout}\n${result.stderr}`),
        summary: `${spec.label}: ${planned.args.join(" ")} (exit ${result.status})`,
      });
      if (planned.plugin !== undefined) {
        blockedPlugins.add(planned.plugin);
      } else if (planned.marketplace !== undefined) {
        blockedMarketplaces.add(planned.marketplace);
      }
    }
  }

  if (spec.marketplaceArgs !== undefined && spec.installArgs === undefined) {
    writeLine(
      runtime.stdout,
      `${spec.label} plugin installation is interactive; run /plugins to enable ${commandSelected.map(pluginRef).join(", ")}`,
    );
  }
}

export type PluginOptions = {
  profile?: string;
  update: boolean;
};

type ParsedArgs =
  | { kind: "run"; options: PluginOptions }
  | { kind: "help" }
  | { kind: "error"; message: string };

const USAGE = "Usage: ./scripts/agents/plugins.ts [--profile PROFILE] [--update]";

export function parseArgs(args: readonly string[]): ParsedArgs {
  let profile: string | undefined;
  let update = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--update") {
      update = true;
      continue;
    }
    if (arg === "--profile") {
      if (profile !== undefined) {
        return { kind: "error", message: `${USAGE}\n--profile may be provided only once` };
      }
      const value = args[index + 1];
      if (value === undefined) {
        return { kind: "error", message: `${USAGE}\n--profile requires a value` };
      }
      profile = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { kind: "help" };
    }
    return { kind: "error", message: `${USAGE}\nUnknown argument: ${arg}` };
  }

  return { kind: "run", options: { profile, update } };
}

function apply(runtime: Runtime, options: PluginOptions): number {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoDir = runtime.repoDir ?? resolve(scriptDir, "../..");
  const profileName = resolveProfileName(runtime, scriptDir, options.profile);

  const model = readProfileModel(resolve(repoDir, "chezmoi/.chezmoidata/profiles.json"));
  const profile = requireProfile(model, profileName);
  const { layers, plugins } = readLayeredPlugins(repoDir, profileName, profile.skillLayers);

  writeLine(runtime.stdout, `Profile: ${profileName}`);
  writeLine(runtime.stdout, `Plugin layers: ${layers.join(", ")}`);

  const pluginLockPath = join(repoDir, "scripts", "agents", "plugins.lock.json");
  const previouslyManaged = readPluginLock(pluginLockPath);

  const failures: PluginFailure[] = [];
  for (const harness of HARNESSES) {
    applyHarness(
      runtime,
      harness,
      plugins,
      failures,
      previouslyManaged !== undefined,
      marketplaceIds(previouslyManaged ?? []),
      options.update,
    );
  }

  if (failures.length > 0) {
    return reportPluginFailures(runtime, failures);
  }

  if (previouslyManaged === undefined) {
    if (!harnessPresent(runtime)) {
      writeLine(runtime.stdout, "No managed plugins lock found; skipping ownership initialization");
      writeLine(runtime.stdout, "Done.");
      return 0;
    }
    writeLine(runtime.stdout, "Initializing managed plugins lock without removing existing plugins");
    writePluginLock(pluginLockPath, appliedPlugins(runtime, plugins));
    writeLine(runtime.stdout, "Done.");
    return 0;
  }

  const leftover = [
    ...removeStalePlugins(runtime, stalePlugins(previouslyManaged, plugins), failures),
    ...retainAbsentPlugins(runtime, previouslyManaged, plugins),
  ];
  if (failures.length > 0) {
    return reportPluginFailures(runtime, failures);
  }

  pruneNativeSkillLinks(runtime, plugins, previouslyManaged);
  writePluginLock(pluginLockPath, mergePluginLock(appliedPlugins(runtime, plugins), leftover));
  writeLine(runtime.stdout, "Done.");
  return 0;
}

function reportPluginFailures(runtime: Runtime, failures: readonly PluginFailure[]): 1 {
  const noun = failures.length === 1 ? "failure" : "failures";
  writeLine(runtime.stderr, `Plugin sync failed for ${failures.length} ${noun}:`);
  for (const failure of failures) {
    writeLine(runtime.stderr, `  - ${failure.summary}`);
    for (const line of failure.diagnostic.split("\n")) {
      if (line.length > 0) {
        writeLine(runtime.stderr, `    ${line}`);
      }
    }
  }
  writeLine(runtime.stderr, "Fix the reported plugin failures, then rerun sync.");
  return 1;
}

export function main(args: readonly string[], runtime: Runtime = createRuntime()): number {
  const parsed = parseArgs(args);
  if (parsed.kind === "help") {
    writeLine(runtime.stdout, USAGE);
    return 0;
  }
  if (parsed.kind === "error") {
    writeLine(runtime.stderr, parsed.message);
    return 2;
  }

  try {
    return apply(runtime, parsed.options);
  } catch (error) {
    writeLine(runtime.stderr, `Plugin sync failed: ${errorMessage(error)}`);
    return 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
