#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

import { runMain } from "../lib/program.ts";
import { readProfileModel, requireProfile, type SkillLayer } from "../profiles/model.ts";
import {
  composeLayers,
  type Harness,
  HARNESS_INFO,
  HARNESSES,
  harnessPresent,
  isSafeName,
  mergeLockEntries,
  parseSyncArgs,
  presentHarnessEntries,
  readHarnesses,
  reportSyncFailures,
  retainAbsentEntries,
  staleEntries,
  type SyncFailure,
} from "./harness.ts";
import { readLockFile, writeLockFile } from "./lock.ts";
import {
  createRuntime,
  errorMessage,
  resolveProfileName,
  type Runtime,
  sanitizeDiagnostic,
  writeLine,
} from "./runtime.ts";

export type McpServer = {
  name: string;
  url: string;
  harnesses: readonly Harness[];
};

type McpFailure = SyncFailure;

function readManifestHarnesses(value: unknown, path: string, name: string): readonly Harness[] {
  if (value === undefined) {
    return HARNESSES;
  }
  return readHarnesses(
    value,
    `Invalid MCP manifest at ${path}: ${name} harnesses must be a unique non-empty subset of ${HARNESSES.join(", ")}`,
  );
}

function readServer(value: unknown, manifestPath: string): McpServer {
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !isSafeName(value.name) ||
    !("url" in value) ||
    typeof value.url !== "string"
  ) {
    throw new Error(
      `Invalid MCP manifest at ${manifestPath}: expected safe server name and url strings`,
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value.url);
  } catch {
    throw new Error(`Invalid MCP manifest at ${manifestPath}: ${value.name} url is not a URL`);
  }
  if (parsedUrl.protocol !== "https:") {
    throw new Error(`Invalid MCP manifest at ${manifestPath}: ${value.name} url must use https`);
  }

  const harnesses = readManifestHarnesses(
    "harnesses" in value ? value.harnesses : undefined,
    manifestPath,
    value.name,
  );

  return { name: value.name, url: value.url, harnesses };
}

export function readServers(manifestPath: string): McpServer[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid MCP manifest at ${manifestPath}: ${errorMessage(error)}`);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("servers" in parsed) ||
    !Array.isArray(parsed.servers)
  ) {
    throw new Error(`Invalid MCP manifest at ${manifestPath}: expected a servers array`);
  }

  const servers = parsed.servers.map((server) => readServer(server, manifestPath));
  const names = new Set<string>();
  for (const server of servers) {
    if (names.has(server.name)) {
      throw new Error(
        `Invalid MCP manifest at ${manifestPath}: ${server.name} is defined more than once`,
      );
    }
    names.add(server.name);
  }
  return servers;
}

export function readLayeredServers(
  repoDir: string,
  profile: string,
  layers: readonly SkillLayer[],
): { layers: readonly SkillLayer[]; servers: McpServer[] } {
  if (layers.length === 0) {
    throw new Error(`Profile ${profile} does not manage MCP servers`);
  }

  const manifests = new Map<SkillLayer, McpServer[]>();
  for (const layer of ["developer", "workstation", "devbox", "personal"] as const) {
    manifests.set(layer, readServers(join(repoDir, "scripts", "agents", "mcps", `${layer}.json`)));
  }

  const servers = composeLayers(
    layers,
    manifests,
    (server) => server.name,
    (name) => `Invalid layered MCP servers: ${name} is defined more than once`,
  );
  return { layers, servers };
}

type LockedServer = {
  name: string;
  harnesses: readonly Harness[];
};

type McpLock = {
  version: 1;
  servers: LockedServer[];
};

function readServerLock(lockPath: string): LockedServer[] | undefined {
  const parsed = readLockFile(lockPath, "MCP");
  if (parsed === undefined) {
    return undefined;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("servers" in parsed) ||
    !Array.isArray(parsed.servers)
  ) {
    throw new Error(`Invalid managed MCP lock at ${lockPath}: expected version 1 and a servers array`);
  }

  const servers = parsed.servers.map((server, index) => {
    if (
      typeof server !== "object" ||
      server === null ||
      !("name" in server) ||
      typeof server.name !== "string" ||
      !isSafeName(server.name)
    ) {
      throw new Error(
        `Invalid managed MCP lock at ${lockPath}: servers[${index}] must have a safe name`,
      );
    }
    return {
      name: server.name,
      harnesses: readHarnesses(
        "harnesses" in server ? server.harnesses : undefined,
        `Invalid managed MCP lock at ${lockPath}: ${server.name} harnesses must be an explicit unique non-empty subset of ${HARNESSES.join(", ")}`,
      ),
    };
  });
  const names = servers.map((server) => server.name);
  if (new Set(names).size !== names.length) {
    throw new Error(`Invalid managed MCP lock at ${lockPath}: server names must be unique`);
  }
  return servers;
}

function writeServerLock(lockPath: string, servers: readonly LockedServer[]): void {
  const lock: McpLock = { version: 1, servers: [...servers] };
  writeLockFile(lockPath, lock);
}

function appliedServers(runtime: Runtime, servers: readonly McpServer[]): LockedServer[] {
  return presentHarnessEntries(
    runtime,
    servers.map((server) => ({ name: server.name, harnesses: server.harnesses })),
  );
}

const serverName = (server: { name: string; harnesses: readonly Harness[] }) => server.name;

function mcpRemoveArgs(harness: Exclude<Harness, "cursor" | "opencode">, name: string): string[] {
  switch (harness) {
    case "claude":
      return ["mcp", "remove", "-s", "user", name];
    case "codex":
      return ["mcp", "remove", name];
    case "grok":
      return ["mcp", "remove", "-s", "user", name];
  }
}

type CommandHarness = Exclude<Harness, "claude" | "codex" | "cursor">;

type CommandSpec = {
  binary: string;
  label: string;
  addArgs(server: McpServer): string[];
};

// grok and opencode `mcp add` are plain config upserts: re-adding a name updates it.
const COMMAND_SPECS: Record<CommandHarness, CommandSpec> = {
  grok: {
    binary: "grok",
    label: "Grok",
    addArgs: (server) => ["mcp", "add", "-t", "http", "-s", "user", server.name, server.url],
  },
  opencode: {
    binary: "opencode",
    label: "OpenCode",
    addArgs: (server) => ["mcp", "add", server.name, "--url", server.url],
  },
};

function runPlanned(
  runtime: Runtime,
  label: string,
  binary: string,
  args: readonly string[],
  failures: McpFailure[],
): boolean {
  writeLine(runtime.stdout, `${label}: ${binary} ${args.join(" ")}`);
  const result = runtime.run(binary, args, { stdout: "capture", stderr: "capture" });
  if (result.status !== 0) {
    failures.push({
      diagnostic: sanitizeDiagnostic(`${result.stdout}\n${result.stderr}`),
      summary: `${label}: ${args.join(" ")} (exit ${result.status})`,
    });
    return false;
  }
  return true;
}

function applyCommandHarness(
  runtime: Runtime,
  harness: CommandHarness,
  servers: readonly McpServer[],
  failures: McpFailure[],
): void {
  const spec = COMMAND_SPECS[harness];
  const selected = servers.filter((server) => server.harnesses.includes(harness));

  if (!runtime.commandExists(spec.binary)) {
    writeLine(runtime.stdout, `Skipping ${spec.label} MCP servers: '${spec.binary}' is not installed`);
    return;
  }
  if (selected.length === 0) {
    writeLine(runtime.stdout, `No ${spec.label} MCP servers are selected for this profile`);
    return;
  }

  for (const server of selected) {
    runPlanned(runtime, spec.label, spec.binary, spec.addArgs(server), failures);
  }
}

// `codex mcp add` upserts the config but then probes the server and can start an
// interactive OAuth login, so converge through get: a matching URL is a no-op,
// and an add whose config landed before the login step failed is a warning.
function applyCodex(runtime: Runtime, servers: readonly McpServer[], failures: McpFailure[]): void {
  const label = "Codex";
  const selected = servers.filter((server) => server.harnesses.includes("codex"));

  if (!runtime.commandExists("codex")) {
    writeLine(runtime.stdout, `Skipping ${label} MCP servers: 'codex' is not installed`);
    return;
  }
  if (selected.length === 0) {
    writeLine(runtime.stdout, `No ${label} MCP servers are selected for this profile`);
    return;
  }

  for (const server of selected) {
    const configuredUrl = `url: ${server.url}\n`;
    const existing = runtime.run("codex", ["mcp", "get", server.name], {
      stdout: "capture",
      stderr: "capture",
    });
    if (existing.status === 0 && existing.stdout.includes(configuredUrl)) {
      writeLine(runtime.stdout, `${label}: ${server.name} is already configured`);
      continue;
    }

    const addArgs = ["mcp", "add", server.name, "--url", server.url];
    writeLine(runtime.stdout, `${label}: codex ${addArgs.join(" ")}`);
    const added = runtime.run("codex", addArgs, { stdout: "capture", stderr: "capture" });
    if (added.status === 0) {
      continue;
    }

    const converged = runtime.run("codex", ["mcp", "get", server.name], {
      stdout: "capture",
      stderr: "capture",
    });
    if (converged.status === 0 && converged.stdout.includes(configuredUrl)) {
      writeLine(
        runtime.stdout,
        `${label}: ${server.name} is configured, but its login did not finish; run 'codex mcp login ${server.name}' if the server needs one`,
      );
      continue;
    }
    failures.push({
      diagnostic: sanitizeDiagnostic(`${added.stdout}\n${added.stderr}`),
      summary: `${label}: ${addArgs.join(" ")} (exit ${added.status})`,
    });
  }
}

// `claude mcp add` refuses an existing name instead of updating it, so converge
// through get: matching URL is a no-op, anything else is removed and re-added.
function applyClaude(runtime: Runtime, servers: readonly McpServer[], failures: McpFailure[]): void {
  const label = "Claude Code";
  const selected = servers.filter((server) => server.harnesses.includes("claude"));

  if (!runtime.commandExists("claude")) {
    writeLine(runtime.stdout, `Skipping ${label} MCP servers: 'claude' is not installed`);
    return;
  }
  if (selected.length === 0) {
    writeLine(runtime.stdout, `No ${label} MCP servers are selected for this profile`);
    return;
  }

  for (const server of selected) {
    const existing = runtime.run("claude", ["mcp", "get", server.name], {
      stdout: "capture",
      stderr: "capture",
    });
    if (existing.status === 0) {
      if (existing.stdout.includes(`URL: ${server.url}\n`)) {
        writeLine(runtime.stdout, `${label}: ${server.name} is already configured`);
        continue;
      }
      const removed = runPlanned(
        runtime,
        label,
        "claude",
        ["mcp", "remove", "-s", "user", server.name],
        failures,
      );
      if (!removed) {
        continue;
      }
    }
    runPlanned(
      runtime,
      label,
      "claude",
      ["mcp", "add", "-t", "http", "-s", "user", server.name, server.url],
      failures,
    );
  }
}

// cursor-agent has no `mcp add`; converge ~/.cursor/mcp.json directly.
function applyCursor(runtime: Runtime, servers: readonly McpServer[], failures: McpFailure[]): void {
  const label = "Cursor";
  const selected = servers.filter((server) => server.harnesses.includes("cursor"));

  if (!runtime.commandExists("cursor-agent")) {
    writeLine(runtime.stdout, `Skipping ${label} MCP servers: 'cursor-agent' is not installed`);
    return;
  }
  if (selected.length === 0) {
    writeLine(runtime.stdout, `No ${label} MCP servers are selected for this profile`);
    return;
  }

  const home = runtime.env.HOME;
  if (!home) {
    failures.push({
      diagnostic: "HOME is required to manage the Cursor MCP config",
      summary: `${label}: ~/.cursor/mcp.json (missing HOME)`,
    });
    return;
  }

  const configPath = join(home, ".cursor", "mcp.json");
  let config: JsonObject = {};
  if (existsSync(configPath)) {
    const parsed = readJsonObjectFile(configPath, label, failures);
    if (parsed === undefined) {
      return;
    }
    config = parsed;
  }

  const existingServers = Object.hasOwn(config, "mcpServers") ? config.mcpServers : undefined;
  const mcpServers: Record<string, unknown> =
    typeof existingServers === "object" && existingServers !== null && !Array.isArray(existingServers)
      ? (existingServers as Record<string, unknown>)
      : {};
  config.mcpServers = mcpServers;

  let changed = false;
  for (const server of selected) {
    const current = Object.hasOwn(mcpServers, server.name) ? mcpServers[server.name] : undefined;
    const entry =
      typeof current === "object" && current !== null && !Array.isArray(current)
        ? (current as Record<string, unknown>)
        : undefined;
    if (entry !== undefined && Object.hasOwn(entry, "url") && entry.url === server.url) {
      continue;
    }
    mcpServers[server.name] = { ...entry, url: server.url };
    changed = true;
  }

  if (!changed) {
    writeLine(runtime.stdout, `${label}: ${selected.length} MCP server(s) already configured`);
    return;
  }

  writeJsonObjectFile(configPath, config);
  writeLine(runtime.stdout, `${label}: updated ${configPath}`);
}

type JsonObject = Record<string, unknown>;

function stripJsonc(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const current = text[index] ?? "";
    const next = text[index + 1] ?? "";

    if (lineComment) {
      if (current === "\n") {
        lineComment = false;
        output += current;
      }
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      output += current;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === '"') {
        inString = false;
      }
      continue;
    }
    if (current === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (current === '"') {
      inString = true;
    }
    output += current;
  }

  return stripTrailingCommas(output);
}

function stripTrailingCommas(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const current = text[index] ?? "";
    if (inString) {
      output += current;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === '"') {
        inString = false;
      }
      continue;
    }
    if (current === '"') {
      inString = true;
      output += current;
      continue;
    }
    if (current === ",") {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead] ?? "")) {
        lookahead += 1;
      }
      const follower = text[lookahead] ?? "";
      if (follower === "}" || follower === "]") {
        continue;
      }
    }
    output += current;
  }

  return output;
}

function parseJsonDocument(text: string, jsonc: boolean): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!jsonc) {
      throw error;
    }
    return JSON.parse(stripJsonc(text));
  }
}

function readJsonObjectFile(
  path: string,
  label: string,
  failures: McpFailure[],
  jsonc = false,
): JsonObject | undefined {
  let parsed: unknown;
  try {
    parsed = parseJsonDocument(readFileSync(path, "utf8"), jsonc);
  } catch (error) {
    failures.push({
      diagnostic: sanitizeDiagnostic(errorMessage(error)),
      summary: `${label}: ${path} is not valid ${jsonc ? "JSONC" : "JSON"}`,
    });
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    failures.push({
      diagnostic: `${path} must contain a JSON object`,
      summary: `${label}: ${path} has an unexpected shape`,
    });
    return undefined;
  }
  return parsed as JsonObject;
}

function writeJsonObjectFile(path: string, value: JsonObject): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryDirectory = mkdtempSync(join(dirname(path), ".mcp-json-"));
  try {
    const temporaryPath = join(temporaryDirectory, "mcp.json");
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

function removeCursorServers(
  runtime: Runtime,
  names: readonly string[],
  failures: McpFailure[],
): boolean {
  const home = runtime.env.HOME;
  if (!home) {
    failures.push({
      diagnostic: "HOME is required to manage the Cursor MCP config",
      summary: "Cursor: ~/.cursor/mcp.json (missing HOME)",
    });
    return false;
  }

  const configPath = join(home, ".cursor", "mcp.json");
  if (!existsSync(configPath)) {
    return true;
  }

  const config = readJsonObjectFile(configPath, "Cursor", failures);
  if (config === undefined) {
    return false;
  }

  const existingServers = Object.hasOwn(config, "mcpServers") ? config.mcpServers : undefined;
  if (typeof existingServers !== "object" || existingServers === null || Array.isArray(existingServers)) {
    return true;
  }

  const mcpServers = existingServers as JsonObject;
  let changed = false;
  for (const name of names) {
    if (Object.hasOwn(mcpServers, name)) {
      delete mcpServers[name];
      changed = true;
    }
  }
  if (!changed) {
    return true;
  }

  writeJsonObjectFile(configPath, config);
  writeLine(runtime.stdout, `Cursor: removed ${names.join(", ")} from ${configPath}`);
  return true;
}

function opencodeConfigPath(home: string): string | undefined {
  const jsonc = join(home, ".config", "opencode", "opencode.jsonc");
  const json = join(home, ".config", "opencode", "opencode.json");
  if (existsSync(jsonc)) {
    return jsonc;
  }
  if (existsSync(json)) {
    return json;
  }
  return undefined;
}

function removeOpenCodeServers(
  runtime: Runtime,
  names: readonly string[],
  failures: McpFailure[],
): boolean {
  const home = runtime.env.HOME;
  if (!home) {
    failures.push({
      diagnostic: "HOME is required to manage the OpenCode MCP config",
      summary: "OpenCode: ~/.config/opencode/opencode.jsonc (missing HOME)",
    });
    return false;
  }

  const configPath = opencodeConfigPath(home);
  if (configPath === undefined) {
    return true;
  }

  const config = readJsonObjectFile(configPath, "OpenCode", failures, true);
  if (config === undefined) {
    return false;
  }

  const existing = Object.hasOwn(config, "mcp") ? config.mcp : undefined;
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
    return true;
  }

  const mcp = existing as JsonObject;
  let changed = false;
  for (const name of names) {
    if (Object.hasOwn(mcp, name)) {
      delete mcp[name];
      changed = true;
    }
  }
  if (!changed) {
    return true;
  }

  writeJsonObjectFile(configPath, config);
  writeLine(runtime.stdout, `OpenCode: removed ${names.join(", ")} from ${configPath}`);
  return true;
}

function removeStaleServers(
  runtime: Runtime,
  stale: readonly LockedServer[],
  failures: McpFailure[],
): LockedServer[] {
  const leftover: LockedServer[] = [];
  const cursorNames: string[] = [];
  const opencodeNames: string[] = [];

  for (const server of stale) {
    const leftoverHarnesses: Harness[] = [];
    for (const harness of server.harnesses) {
      const { binary, label } = HARNESS_INFO[harness];
      if (!runtime.commandExists(binary)) {
        leftoverHarnesses.push(harness);
        writeLine(runtime.stdout, `Skipping ${label} MCP removal: '${binary}' is not installed`);
        continue;
      }

      if (harness === "cursor") {
        cursorNames.push(server.name);
        continue;
      }
      if (harness === "opencode") {
        opencodeNames.push(server.name);
        continue;
      }

      const args = mcpRemoveArgs(harness, server.name);
      writeLine(runtime.stdout, `Removing stale managed MCP server: ${server.name} from ${label}`);
      const removed = runPlanned(runtime, label, binary, args, failures);
      if (!removed) {
        leftoverHarnesses.push(harness);
      }
    }

    if (leftoverHarnesses.length > 0) {
      leftover.push({ name: server.name, harnesses: leftoverHarnesses });
    }
  }

  if (cursorNames.length > 0 && !removeCursorServers(runtime, cursorNames, failures)) {
    for (const name of cursorNames) {
      if (!leftover.some((server) => server.name === name && server.harnesses.includes("cursor"))) {
        leftover.push({ name, harnesses: ["cursor"] });
      }
    }
  }
  if (opencodeNames.length > 0 && !removeOpenCodeServers(runtime, opencodeNames, failures)) {
    for (const name of opencodeNames) {
      if (!leftover.some((server) => server.name === name && server.harnesses.includes("opencode"))) {
        leftover.push({ name, harnesses: ["opencode"] });
      }
    }
  }

  return leftover;
}

export type McpOptions = {
  profile?: string;
};

const USAGE = "Usage: ./scripts/agents/mcps.ts [--profile PROFILE]";

function apply(runtime: Runtime, options: McpOptions): number {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoDir = runtime.repoDir ?? resolve(scriptDir, "../..");
  const profileName = resolveProfileName(runtime, scriptDir, options.profile);

  const model = readProfileModel(resolve(repoDir, "chezmoi/.chezmoidata/profiles.json"));
  const profile = requireProfile(model, profileName);
  const { layers, servers } = readLayeredServers(repoDir, profileName, profile.skillLayers);

  writeLine(runtime.stdout, `Profile: ${profileName}`);
  writeLine(runtime.stdout, `MCP layers: ${layers.join(", ")}`);

  const mcpLockPath = join(repoDir, "scripts", "agents", "mcps.lock.json");
  const previouslyManaged = readServerLock(mcpLockPath);

  const failures: McpFailure[] = [];
  for (const harness of HARNESSES) {
    if (harness === "claude") {
      applyClaude(runtime, servers, failures);
    } else if (harness === "codex") {
      applyCodex(runtime, servers, failures);
    } else if (harness === "cursor") {
      applyCursor(runtime, servers, failures);
    } else {
      applyCommandHarness(runtime, harness, servers, failures);
    }
  }

  if (failures.length > 0) {
    return reportMcpFailures(runtime, failures);
  }

  if (previouslyManaged === undefined) {
    if (!harnessPresent(runtime)) {
      writeLine(runtime.stdout, "No managed MCP lock found; skipping ownership initialization");
      writeLine(runtime.stdout, "Done.");
      return 0;
    }
    writeLine(runtime.stdout, "Initializing managed MCP lock without removing existing servers");
    writeServerLock(mcpLockPath, appliedServers(runtime, servers));
    writeLine(runtime.stdout, "Done.");
    return 0;
  }

  const leftover = [
    ...removeStaleServers(runtime, staleEntries(previouslyManaged, servers, serverName), failures),
    ...retainAbsentEntries(runtime, previouslyManaged, servers, serverName),
  ];
  if (failures.length > 0) {
    return reportMcpFailures(runtime, failures);
  }

  writeServerLock(
    mcpLockPath,
    mergeLockEntries(appliedServers(runtime, servers), leftover, serverName),
  );
  writeLine(runtime.stdout, "Done.");
  return 0;
}

function reportMcpFailures(runtime: Runtime, failures: readonly McpFailure[]): 1 {
  return reportSyncFailures(runtime, failures, "MCP sync", ["command", "commands"], "MCP");
}

export function main(args: readonly string[], runtime: Runtime = createRuntime()): number {
  const parsed = parseSyncArgs(args, USAGE, false);
  if (parsed.kind === "help") {
    writeLine(runtime.stdout, USAGE);
    return 0;
  }
  if (parsed.kind === "error") {
    writeLine(runtime.stderr, parsed.message);
    return 2;
  }

  try {
    return apply(runtime, { profile: parsed.profile });
  } catch (error) {
    writeLine(runtime.stderr, `MCP sync failed: ${errorMessage(error)}`);
    return 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  runMain(Effect.sync(() => { process.exitCode = main(process.argv.slice(2)); }));
}
