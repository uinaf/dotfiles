#!/usr/bin/env node

import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readProfileModel, requireProfile, type SkillLayer } from "../profiles/model.ts";
import { HARNESSES, type Harness } from "./plugins.ts";
import {
  createRuntime,
  errorMessage,
  resolveProfileName,
  type Runtime,
  sanitizeDiagnostic,
  writeLine,
} from "./runtime.ts";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type McpServer = {
  name: string;
  url: string;
  harnesses: readonly Harness[];
};

type McpFailure = {
  diagnostic: string;
  summary: string;
};

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
      `Invalid MCP manifest at ${manifestPath}: ${name} harnesses must be a unique non-empty subset of ${HARNESSES.join(", ")}`,
    );
  }
  // Selection uses membership, never order; normalize so composition compares
  // manifests by meaning rather than authoring order.
  return HARNESSES.filter((harness) => value.includes(harness));
}

function readServer(value: unknown, manifestPath: string): McpServer {
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !NAME_PATTERN.test(value.name) ||
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

  const harnesses = readHarnesses(
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

  const seen = new Map<string, string>();
  const servers: McpServer[] = [];
  for (const server of layers.flatMap((layer) => manifests.get(layer) ?? [])) {
    const shape = JSON.stringify(server);
    const previous = seen.get(server.name);
    if (previous === shape) {
      continue; // the same server selected by more than one composed layer
    }
    if (previous !== undefined) {
      throw new Error(`Invalid layered MCP servers: ${server.name} is defined more than once`);
    }
    seen.set(server.name, shape);
    servers.push(server);
  }

  return { layers, servers };
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
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (error) {
      failures.push({
        diagnostic: sanitizeDiagnostic(errorMessage(error)),
        summary: `${label}: ${configPath} is not valid JSON`,
      });
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      failures.push({
        diagnostic: `${configPath} must contain a JSON object`,
        summary: `${label}: ${configPath} has an unexpected shape`,
      });
      return;
    }
    config = parsed as Record<string, unknown>;
  }

  const existingServers = config.mcpServers;
  const mcpServers: Record<string, unknown> =
    typeof existingServers === "object" && existingServers !== null && !Array.isArray(existingServers)
      ? (existingServers as Record<string, unknown>)
      : {};
  config.mcpServers = mcpServers;

  let changed = false;
  for (const server of selected) {
    const current = mcpServers[server.name];
    const entry =
      typeof current === "object" && current !== null && !Array.isArray(current)
        ? (current as Record<string, unknown>)
        : undefined;
    if (entry !== undefined && entry.url === server.url) {
      continue;
    }
    mcpServers[server.name] = { ...entry, url: server.url };
    changed = true;
  }

  if (!changed) {
    writeLine(runtime.stdout, `${label}: ${selected.length} MCP server(s) already configured`);
    return;
  }

  mkdirSync(dirname(configPath), { recursive: true });
  const temporaryDirectory = mkdtempSync(join(dirname(configPath), ".mcp-json-"));
  try {
    const temporaryPath = join(temporaryDirectory, "mcp.json");
    writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, configPath);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
  writeLine(runtime.stdout, `${label}: updated ${configPath}`);
}

export type McpOptions = {
  profile?: string;
};

type ParsedArgs =
  | { kind: "run"; options: McpOptions }
  | { kind: "help" }
  | { kind: "error"; message: string };

const USAGE = "Usage: ./scripts/agents/mcps.ts [--profile PROFILE]";

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

function apply(runtime: Runtime, options: McpOptions): number {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoDir = runtime.repoDir ?? resolve(scriptDir, "../..");
  const profileName = resolveProfileName(runtime, scriptDir, options.profile);

  const model = readProfileModel(resolve(repoDir, "chezmoi/.chezmoidata/profiles.json"));
  const profile = requireProfile(model, profileName);
  const { layers, servers } = readLayeredServers(repoDir, profileName, profile.skillLayers);

  writeLine(runtime.stdout, `Profile: ${profileName}`);
  writeLine(runtime.stdout, `MCP layers: ${layers.join(", ")}`);

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
    const noun = failures.length === 1 ? "command" : "commands";
    writeLine(runtime.stderr, `MCP sync failed for ${failures.length} ${noun}:`);
    for (const failure of failures) {
      writeLine(runtime.stderr, `  - ${failure.summary}`);
      for (const line of failure.diagnostic.split("\n")) {
        if (line.length > 0) {
          writeLine(runtime.stderr, `    ${line}`);
        }
      }
    }
    writeLine(runtime.stderr, "Fix the reported MCP failures, then rerun sync.");
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
    writeLine(runtime.stderr, `MCP sync failed: ${errorMessage(error)}`);
    return 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
