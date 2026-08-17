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

// Claude must precede opencode: the OpenCode skill links resolve into the
// Claude marketplace checkout that Claude's own sync creates and updates.
export const HARNESSES = ["claude", "codex", "cursor", "grok", "opencode"] as const;

export type Harness = (typeof HARNESSES)[number];

export type Plugin = {
  marketplace: string;
  marketplaceId: string;
  name: string;
  harnesses: readonly Harness[];
};

export type PlannedCommand = {
  command: string;
  args: readonly string[];
  // Set on install commands whose harness installs a whole marketplace repository,
  // so apply can skip sources its CLI already lists.
  marketplace?: string;
};

type PluginFailure = {
  diagnostic: string;
  summary: string;
};

type HarnessSpec = {
  binary: string;
  label: string;
  marketplaceArgs?(plugin: Plugin): string[];
  // Cursor exposes no non-interactive install subcommand; installation happens via /plugins.
  installArgs?(plugin: Plugin): string[];
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
  },
  codex: {
    binary: "codex",
    label: "Codex",
    marketplaceArgs: (plugin) => ["plugin", "marketplace", "add", plugin.marketplace],
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
    !NAME_PATTERN.test(value.name)
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
  if (typeof marketplaceId !== "string" || !NAME_PATTERN.test(marketplaceId)) {
    throw new Error(
      `Invalid plugins manifest at ${manifestPath}: ${value.name} marketplaceId must be a safe name`,
    );
  }

  const harnesses = readHarnesses(
    "harnesses" in value ? value.harnesses : undefined,
    manifestPath,
    value.name,
  );

  return { marketplace: value.marketplace, marketplaceId, name: value.name, harnesses };
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

export function planHarness(harness: Harness, plugins: readonly Plugin[]): PlannedCommand[] {
  const spec = HARNESS_SPECS[harness];
  const selected = plugins.filter((plugin) => plugin.harnesses.includes(harness));
  const planned: PlannedCommand[] = [];
  const marketplaces = new Set<string>();

  const marketplaceArgs = spec.marketplaceArgs;
  if (marketplaceArgs !== undefined) {
    for (const plugin of selected) {
      if (marketplaces.has(plugin.marketplace)) {
        continue;
      }
      marketplaces.add(plugin.marketplace);
      planned.push({ command: spec.binary, args: marketplaceArgs(plugin) });
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
    planned.push({ command: spec.binary, args: installArgs(plugin) });
  }

  return planned;
}

function claudeMarketplacesRoot(home: string): string {
  return join(home, ".claude", "plugins", "marketplaces");
}

function removeBrokenSkillLinks(home: string, linkRoot: string): number {
  if (!existsSync(linkRoot)) {
    return 0;
  }

  const managedRoot = claudeMarketplacesRoot(home) + sep;
  let removed = 0;
  for (const entry of readdirSync(linkRoot)) {
    const linkPath = join(linkRoot, entry);
    if (!lstatSync(linkPath).isSymbolicLink()) {
      continue;
    }
    const target = readlinkSync(linkPath);
    if (target.startsWith(managedRoot) && !existsSync(linkPath)) {
      unlinkSync(linkPath);
      removed += 1;
    }
  }
  return removed;
}

function linkClaudeSkills(
  runtime: Runtime,
  label: string,
  selected: readonly Plugin[],
  failures: PluginFailure[],
): void {
  const home = runtime.env.HOME;
  if (!home) {
    failures.push({
      diagnostic: "HOME is required to link OpenCode skills",
      summary: `${label}: skill links (missing HOME)`,
    });
    return;
  }

  const linkRoot = join(home, ".config", "opencode", "skills");
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
        if (readlinkSync(linkPath) === target) {
          linked += 1;
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

  const removed = removeBrokenSkillLinks(home, linkRoot);
  if (removed > 0) {
    writeLine(runtime.stdout, `${label}: removed ${removed} broken managed skill links`);
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

function applyHarness(
  runtime: Runtime,
  harness: Harness,
  plugins: readonly Plugin[],
  failures: PluginFailure[],
): void {
  const spec = HARNESS_SPECS[harness];
  const selected = plugins.filter((plugin) => plugin.harnesses.includes(harness));

  if (!runtime.commandExists(spec.binary)) {
    writeLine(runtime.stdout, `Skipping ${spec.label} plugins: '${spec.binary}' is not installed`);
    return;
  }
  if (selected.length === 0) {
    writeLine(runtime.stdout, `No ${spec.label} plugins are selected for this profile`);
    return;
  }

  if (spec.linksClaudeSkills === true) {
    linkClaudeSkills(runtime, spec.label, selected, failures);
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

  for (const planned of planHarness(harness, plugins)) {
    if (guard !== undefined && planned.marketplace !== undefined) {
      const plugin = selected.find((candidate) => candidate.marketplace === planned.marketplace);
      if (plugin !== undefined && guard.installed(installedSources, plugin)) {
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
    }
  }

  if (spec.marketplaceArgs !== undefined && spec.installArgs === undefined) {
    writeLine(
      runtime.stdout,
      `${spec.label} plugin installation is interactive; run /plugins to enable ${selected.map(pluginRef).join(", ")}`,
    );
  }
}

export type PluginOptions = {
  profile?: string;
};

type ParsedArgs =
  | { kind: "run"; options: PluginOptions }
  | { kind: "help" }
  | { kind: "error"; message: string };

const USAGE = "Usage: ./scripts/agents/plugins.ts [--profile PROFILE]";

export function parseArgs(args: readonly string[]): ParsedArgs {
  let profile: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
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

  return { kind: "run", options: { profile } };
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

  const failures: PluginFailure[] = [];
  for (const harness of HARNESSES) {
    applyHarness(runtime, harness, plugins, failures);
  }

  if (failures.length > 0) {
    const noun = failures.length === 1 ? "command" : "commands";
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

  writeLine(runtime.stdout, "Done.");
  return 0;
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
