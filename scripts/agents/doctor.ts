#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

import { runMain } from "../lib/program.ts";
import { readProfileModel, requireProfile } from "../profiles/model.ts";
import { HARNESS_INFO, HARNESSES, type Harness, parseSyncArgs } from "./harness.ts";
import { type McpServer, readLayeredServers } from "./mcps.ts";
import { createRuntime, errorMessage, resolveProfileName, type Runtime, writeLine } from "./runtime.ts";

const USAGE = `Usage: ./scripts/agents/doctor.ts [--profile PROFILE]

Reports the MCP authentication state of every managed server in each installed
harness and the command that repairs it. Cursor stores MCP OAuth per project
directory, so its row describes the current working directory. Exits 1 when a
server needs a login or the Grok installation drifted from the profile.`;

type Status = "ok" | "needs_login" | "unknown" | "failed";

type Finding = {
  harness: Harness;
  server: string;
  status: Status;
  detail: string;
  repair?: string;
};

const stripAnsi = (text: string) => text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

function capture(runtime: Runtime, command: string, args: readonly string[]) {
  const result = runtime.run(command, args, { stdout: "capture", stderr: "capture" });
  return { ...result, text: stripAnsi(`${result.stdout}\n${result.stderr}`) };
}

function claudeFinding(runtime: Runtime, server: McpServer): Finding {
  const result = capture(runtime, "claude", ["mcp", "get", server.name]);
  const statusLine = result.text.split("\n").find((line) => line.trim().startsWith("Status:"))?.trim() ?? "";
  const repair = `claude mcp login ${server.name}`;
  if (result.status !== 0) {
    return { harness: "claude", server: server.name, status: "failed", detail: result.text.trim().split("\n").at(-1) ?? "mcp get failed", repair: "mise run agents:sync" };
  }
  if (statusLine.includes("Connected")) {
    return { harness: "claude", server: server.name, status: "ok", detail: "connected" };
  }
  if (/auth/i.test(statusLine)) {
    return { harness: "claude", server: server.name, status: "needs_login", detail: statusLine.replace("Status:", "").trim(), repair };
  }
  return { harness: "claude", server: server.name, status: "unknown", detail: statusLine || "no status reported", repair };
}

// `codex mcp list --json` reports the auth mode, not whether the stored OAuth
// session is still valid; Codex only reveals that when a session starts.
function codexFinding(runtime: Runtime, server: McpServer): Finding {
  const result = capture(runtime, "codex", ["mcp", "list", "--json"]);
  const repair = `codex mcp login ${server.name}`;
  if (result.status !== 0) {
    return { harness: "codex", server: server.name, status: "failed", detail: result.text.trim().split("\n").at(-1) ?? "mcp list failed", repair: "mise run agents:sync" };
  }
  let entries: unknown;
  try {
    entries = JSON.parse(result.stdout);
  } catch (error) {
    return { harness: "codex", server: server.name, status: "failed", detail: `unparseable mcp list: ${errorMessage(error)}`, repair };
  }
  const entry = Array.isArray(entries)
    ? entries.find((item) => typeof item === "object" && item !== null && "name" in item && item.name === server.name)
    : undefined;
  if (entry === undefined) {
    return { harness: "codex", server: server.name, status: "failed", detail: "not configured", repair: "mise run agents:sync" };
  }
  const auth = typeof entry === "object" && entry !== null && "auth_status" in entry ? String(entry.auth_status) : "unknown";
  return { harness: "codex", server: server.name, status: "unknown", detail: `${auth}; session validity is only reported at startup`, repair };
}

function cursorFinding(runtime: Runtime, server: McpServer, text: string): Finding {
  const line = text.split("\n").map((item) => item.trim()).find((item) => item.startsWith(`${server.name}:`));
  const repair = `cursor-agent mcp login ${server.name}  # in the project directory, or: ./scripts/agents/cursor-mcp-seed.ts`;
  if (line === undefined) {
    return { harness: "cursor", server: server.name, status: "failed", detail: "not listed", repair: "mise run agents:sync" };
  }
  const state = line.slice(server.name.length + 1).trim();
  if (state === "ready") {
    return { harness: "cursor", server: server.name, status: "ok", detail: `ready in ${runtime.env.PWD ?? process.cwd()}` };
  }
  if (state.includes("auth")) {
    return { harness: "cursor", server: server.name, status: "needs_login", detail: `${state} in ${runtime.env.PWD ?? process.cwd()}`, repair };
  }
  return { harness: "cursor", server: server.name, status: "unknown", detail: state, repair };
}

function opencodeFinding(server: McpServer, text: string): Finding {
  const line = text.split("\n").map((item) => item.trim()).find((item) => item.includes(` ${server.name} `) || item.endsWith(` ${server.name}`));
  const repair = `opencode mcp auth ${server.name}`;
  if (line === undefined) {
    return { harness: "opencode", server: server.name, status: "failed", detail: "not listed", repair: "mise run agents:sync" };
  }
  if (line.includes("connected")) {
    return { harness: "opencode", server: server.name, status: "ok", detail: "connected" };
  }
  if (/auth|expired|failed/i.test(line)) {
    return { harness: "opencode", server: server.name, status: "needs_login", detail: line.replace(/^[^a-z]*/i, "").replace(server.name, "").trim(), repair };
  }
  return { harness: "opencode", server: server.name, status: "unknown", detail: line, repair };
}

type GrokDoctor = {
  servers: Array<{ name: string; healthy: boolean; checks: Array<{ label: string; passed: boolean; detail?: string }> }>;
};

function parseGrokDoctor(stdout: string): GrokDoctor | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null || !("servers" in parsed) || !Array.isArray(parsed.servers)) {
      return undefined;
    }
    return parsed as GrokDoctor;
  } catch {
    return undefined;
  }
}

function grokFinding(server: McpServer, doctor: GrokDoctor | undefined, text: string): Finding {
  const repair = `./scripts/agents/grok-mcp-login.ts ${server.name}  # or: grok, /mcps, select it, press i`;
  if (doctor === undefined) {
    const syntax = text.split("\n").find((line) => line.includes("syntax errors"));
    return { harness: "grok", server: server.name, status: "failed", detail: syntax ? "~/.grok/config.toml does not parse: " + syntax.replace(/^.*syntax errors: /, "") : "mcp doctor produced no JSON", repair: syntax ? "fix ~/.grok/config.toml (duplicate Hindsight block?), then mise run agents:sync" : "grok mcp doctor" };
  }
  const entry = doctor.servers.find((item) => item.name === server.name);
  if (entry === undefined) {
    return { harness: "grok", server: server.name, status: "failed", detail: "not configured", repair: "mise run agents:sync" };
  }
  if (entry.healthy) {
    const tools = entry.checks.find((check) => /tools discovered/.test(check.label))?.label ?? "handshake OK";
    return { harness: "grok", server: server.name, status: "ok", detail: tools };
  }
  const failing = entry.checks.find((check) => !check.passed);
  const detail = `${failing?.label ?? "unhealthy"}${failing?.detail ? `: ${failing.detail}` : ""}`;
  return { harness: "grok", server: server.name, status: /auth/i.test(detail) ? "needs_login" : "failed", detail: detail.slice(0, 160), repair };
}

// Grok's self-updater and npm package both shadow the Homebrew cask. Every
// managed host installs the cask, so any other copy is drift.
function grokDriftFindings(runtime: Runtime): Finding[] {
  const findings: Finding[] = [];
  const home = runtime.env.HOME;
  if (home !== undefined && existsSync(join(home, ".grok", "bin"))) {
    findings.push({ harness: "grok", server: "install", status: "failed", detail: "~/.grok/bin exists (self-updater copy shadows the Homebrew cask)", repair: "rm -rf ~/.grok/bin" });
  }
  const which = capture(runtime, "sh", ["-c", "command -v grok"]);
  const path = which.stdout.trim();
  if (which.status === 0 && path.length > 0 && !path.startsWith("/opt/homebrew/bin/") && !path.startsWith("/usr/local/bin/")) {
    findings.push({ harness: "grok", server: "install", status: "failed", detail: `grok resolves to ${path}, not the Homebrew cask`, repair: "npm uninstall -g @xai-official/grok; mise reshim; brew install --cask grok-build" });
  }
  return findings;
}

function collect(runtime: Runtime, servers: readonly McpServer[]): Finding[] {
  const findings: Finding[] = [];
  const selected = (harness: Harness) => servers.filter((server) => server.harnesses.includes(harness));
  for (const harness of HARNESSES) {
    const { binary, label } = HARNESS_INFO[harness];
    if (!runtime.commandExists(binary)) {
      writeLine(runtime.stdout, `Skipping ${label}: '${binary}' is not installed`);
      continue;
    }
    const chosen = selected(harness);
    if (chosen.length === 0) {
      continue;
    }
    switch (harness) {
      case "claude":
        findings.push(...chosen.map((server) => claudeFinding(runtime, server)));
        break;
      case "codex":
        findings.push(...chosen.map((server) => codexFinding(runtime, server)));
        break;
      case "cursor": {
        const text = capture(runtime, "cursor-agent", ["mcp", "list"]).text;
        findings.push(...chosen.map((server) => cursorFinding(runtime, server, text)));
        break;
      }
      case "opencode": {
        const text = capture(runtime, "opencode", ["mcp", "list"]).text;
        findings.push(...chosen.map((server) => opencodeFinding(server, text)));
        break;
      }
      case "grok": {
        const result = capture(runtime, "grok", ["mcp", "doctor", "--json"]);
        const doctor = parseGrokDoctor(result.stdout);
        findings.push(...chosen.map((server) => grokFinding(server, doctor, result.text)));
        findings.push(...grokDriftFindings(runtime));
        break;
      }
    }
  }
  return findings;
}

const MARK: Record<Status, string> = { ok: "ok", needs_login: "LOGIN", unknown: "?", failed: "FAIL" };

export function report(runtime: Runtime, findings: readonly Finding[]): number {
  for (const finding of findings) {
    const label = HARNESS_INFO[finding.harness].label;
    writeLine(runtime.stdout, `${MARK[finding.status].padEnd(5)} ${label}: ${finding.server} - ${finding.detail}`);
    if ((finding.status === "needs_login" || finding.status === "failed") && finding.repair !== undefined) {
      writeLine(runtime.stdout, `      repair: ${finding.repair}`);
    }
  }
  const broken = findings.filter((finding) => finding.status === "needs_login" || finding.status === "failed");
  writeLine(runtime.stdout, broken.length === 0 ? "All managed MCP servers are usable." : `${broken.length} MCP server state(s) need attention.`);
  return broken.length === 0 ? 0 : 1;
}

function run(runtime: Runtime, profileOverride: string | undefined): number {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoDir = runtime.repoDir ?? resolve(scriptDir, "../..");
  const profileName = resolveProfileName(runtime, scriptDir, profileOverride);
  const model = readProfileModel(resolve(repoDir, "chezmoi/.chezmoidata/profiles.json"));
  const profile = requireProfile(model, profileName);
  const { servers } = readLayeredServers(repoDir, profileName, profile.skillLayers);
  writeLine(runtime.stdout, `Profile: ${profileName}`);
  return report(runtime, collect(runtime, servers));
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
    return run(runtime, parsed.profile);
  } catch (error) {
    writeLine(runtime.stderr, `MCP doctor failed: ${errorMessage(error)}`);
    return 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  runMain(Effect.sync(() => { process.exitCode = main(process.argv.slice(2)); }));
}
