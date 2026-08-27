#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { Effect } from "effect";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runMain } from "../lib/program.ts";

import { sanitizeDiagnostic } from "../agents/runtime.ts";
import { type ProfileConfig, readProfileModel, requireProfile } from "../profiles/model.ts";
import {
  collectMacOSUpdateInventory,
  defaultMacOSUpdateIO,
  type CommandRunner,
  type MacOSUpdateIO,
  type MacOSUpdateInventory,
  type RawCommandResult,
} from "./macos-updates.ts";

export type { CommandRunner, RawCommandResult } from "./macos-updates.ts";

type ProbeStatus = "ok" | "failed" | "timed_out" | "unavailable";

export type ProbeResult<Value = unknown> = {
  status: ProbeStatus;
  required: boolean;
  duration_ms: number;
  value?: Value;
  error?: string;
};

type MaintenanceProbes = Record<string, ProbeResult> & {
  software_update?: ProbeResult<MacOSUpdateInventory>;
};

type Probe = {
  id: string;
  command: string;
  args: readonly string[];
  required: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  allowedStatuses?: readonly number[];
  parse: (result: RawCommandResult) => unknown;
};

export type MaintenanceContext = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  home: string;
  hostname: string;
  ownsHomebrew: boolean;
  platform: NodeJS.Platform;
  profile: string;
  profileConfig: ProfileConfig;
  repoRoot: string;
  user: string;
  fresh: boolean;
  verify: boolean;
};

type BrewItem = {
  name: string;
  installed_versions: string[];
  current_version: string;
};

type BrewBacklog = {
  formulae: BrewItem[];
  casks: BrewItem[];
};

const defaultTimeoutMs = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(contents: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(contents || "{}");
  if (!isRecord(parsed)) throw new Error(`${label} did not return a JSON object`);
  return parsed;
}

function parseBrewItem(value: unknown): BrewItem {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    !Array.isArray(value.installed_versions) ||
    !value.installed_versions.every((item) => typeof item === "string") ||
    typeof value.current_version !== "string"
  ) {
    throw new Error("Homebrew returned an invalid package record");
  }
  return {
    name: value.name,
    installed_versions: value.installed_versions,
    current_version: value.current_version,
  };
}

export function parseBrewBacklog(contents: string): BrewBacklog {
  const value = parseJsonObject(contents, "Homebrew");
  if (!Array.isArray(value.formulae) || !Array.isArray(value.casks)) {
    throw new Error("Homebrew backlog is missing formulae or casks");
  }
  return {
    formulae: value.formulae.map(parseBrewItem),
    casks: value.casks.map(parseBrewItem),
  };
}

function firstLine(result: RawCommandResult): string {
  return `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function parseDisk(result: RawCommandResult) {
  const fields = result.stdout.trim().split(/\r?\n/).at(-1)?.trim().split(/\s+/) ?? [];
  if (fields.length < 6) throw new Error("df returned an unsupported shape");
  return {
    total_kb: Number(fields[1]),
    used_kb: Number(fields[2]),
    available_kb: Number(fields[3]),
    capacity: fields[4],
    mount: fields.at(-1),
  };
}

function parseTailscale(result: RawCommandResult) {
  const value = parseJsonObject(result.stdout, "Tailscale");
  const self = isRecord(value.Self) ? value.Self : {};
  const peers = isRecord(value.Peer) ? Object.values(value.Peer).filter(isRecord) : [];
  return {
    backend_state: typeof value.BackendState === "string" ? value.BackendState : "unknown",
    magic_dns_suffix: typeof value.MagicDNSSuffix === "string" ? value.MagicDNSSuffix : "",
    self_online: self.Online === true,
    peers_total: peers.length,
    peers_online: peers.filter((peer) => peer.Online === true).length,
  };
}

function parseGitStatus(result: RawCommandResult) {
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  return { branch: lines[0] ?? "", dirty_entries: Math.max(0, lines.length - 1) };
}

function parseWorktrees(result: RawCommandResult) {
  return { count: result.stdout.split(/\r?\n/).filter((line) => line.startsWith("worktree ")).length };
}

function summaryLine(result: RawCommandResult) {
  return { passed: result.status === 0, summary: firstLine({ ...result, stdout: result.stdout.trim().split(/\r?\n/).at(-1) ?? "" }) };
}

function probe(
  id: string,
  command: string,
  args: readonly string[],
  parse: Probe["parse"],
  options: Partial<Pick<Probe, "required" | "timeoutMs" | "env" | "allowedStatuses">> = {},
): Probe {
  return { id, command, args, parse, required: options.required ?? true, ...options };
}

function agentProbes(profile: ProfileConfig): Probe[] {
  const versions: Array<[string, string, string[]]> = [];
  if (profile.runtimeGroup !== "none") versions.push(["node", "node", ["--version"]], ["npm", "npm", ["--version"]]);
  if (profile.capabilities.developer) {
    versions.push(
      ["codex", "codex", ["--version"]],
      ["claude", "claude", ["--version"]],
      ["opencode", "opencode", ["--version"]],
      ["cursor_agent", "cursor-agent", ["--version"]],
    );
  }
  if (profile.capabilities.personal) versions.push(["pi", "pi", ["--version"]]);
  if (profile.capabilities.personal && profile.capabilities.workstation) versions.push(["grok", "grok", ["--version"]]);
  return versions.map(([id, command, args]) => probe(`version_${id}`, command, args, firstLine));
}

function checkoutPath(context: MaintenanceContext): string | undefined {
  return context.repoRoot.startsWith(`${context.home}/`) && existsSync(join(context.repoRoot, ".git"))
    ? context.repoRoot
    : undefined;
}

function selectedSkillNames(context: MaintenanceContext): string[] {
  const names = new Set<string>();
  for (const layer of context.profileConfig.skillLayers) {
    const value = parseJsonObject(readFileSync(join(context.repoRoot, `scripts/agents/skills/${layer}.json`), "utf8"), `${layer} skills`);
    if (!Array.isArray(value.skills)) throw new Error(`${layer} skills are missing`);
    for (const skill of value.skills) {
      if (!isRecord(skill) || typeof skill.name !== "string") throw new Error(`${layer} skills contain an invalid entry`);
      names.add(skill.name);
    }
  }
  return [...names].sort();
}

function skillFacts(context: MaintenanceContext) {
  if (context.profileConfig.skillLayers.length === 0) return { managed: false, selected: 0, locked: 0, installed: 0 };
  const selected = selectedSkillNames(context);
  const lockPath = join(context.repoRoot, "scripts/agents/skills.lock.json");
  const lock = existsSync(lockPath) ? parseJsonObject(readFileSync(lockPath, "utf8"), "skill lock") : {};
  const locked = Array.isArray(lock.skills) ? lock.skills.length : 0;
  const installedRoot = join(context.home, ".agents/skills");
  const installed = existsSync(installedRoot)
    ? readdirSync(installedRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(join(installedRoot, entry.name, "SKILL.md"))).length
    : 0;
  return { managed: true, selected: selected.length, locked, installed };
}

function buildProbes(context: MaintenanceContext): Probe[] {
  const hostOwner = context.ownsHomebrew || context.profileConfig.capabilities.workstation;
  const probes: Probe[] = [
    probe("mise_outdated", "mise", ["outdated", "--json"], (result) => parseJsonObject(result.stdout, "mise"), { allowedStatuses: [0, 1] }),
    probe("npm_outdated", "npm", ["outdated", "-g", "--json"], (result) => parseJsonObject(result.stdout, "npm"), { allowedStatuses: [0, 1] }),
    ...agentProbes(context.profileConfig),
  ];

  if (hostOwner) {
    probes.push(
      probe("system", context.platform === "darwin" ? "sw_vers" : "uname", context.platform === "darwin" ? [] : ["-sr"], (result) => result.stdout.trim()),
      probe("disk", "df", ["-Pk", "/"], parseDisk),
      probe("uptime", "uptime", [], (result) => result.stdout.trim()),
      probe("tailscale_status", "tailscale", ["status", "--json"], parseTailscale),
      probe("tailscale_version", "tailscale", ["version"], firstLine),
    );
  }
  if (context.ownsHomebrew) {
    const brewEnv = { ...context.env, HOMEBREW_NO_AUTO_UPDATE: "1" };
    probes.push(probe("brew_outdated_greedy", "brew", ["outdated", "--greedy", "--json=v2"], (result) => parseBrewBacklog(result.stdout), { env: brewEnv }));
  }
  if (context.profileConfig.capabilities.personal && context.profileConfig.capabilities.workstation) {
    probes.push(probe("mas_outdated", "mas", ["outdated"], (result) => result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean), {
      env: { ...context.env, MAS_NO_AUTO_INDEX: "1" },
      required: false,
    }));
  }
  if (context.profileConfig.capabilities.sharedHomebrew) {
    probes.push(probe("devbox_services", process.execPath, [join(context.repoRoot, "scripts/verify/devbox-services.ts")], summaryLine, { timeoutMs: 30_000 }));
  }
  if (context.verify) {
    probes.push(probe("bootstrap", process.execPath, [join(context.repoRoot, "scripts/verify/bootstrap.ts"), "--profile", context.profile], summaryLine, { timeoutMs: 60_000 }));
  }

  const checkout = checkoutPath(context);
  if (checkout) {
    probes.push(
      probe("dotfiles_status", "git", ["status", "--short", "--branch"], parseGitStatus, { env: context.env }),
      probe("dotfiles_worktrees", "git", ["worktree", "list", "--porcelain"], parseWorktrees, { env: context.env }),
    );
    for (const item of probes.slice(-2)) item.env = { ...item.env, DOTFILES_CHECKOUT: checkout };
  }
  return probes;
}

export async function runProbe(spec: Probe, context: MaintenanceContext, runner: CommandRunner): Promise<ProbeResult> {
  const started = performance.now();
  const cwd = spec.env?.DOTFILES_CHECKOUT || context.cwd;
  const env = { ...context.env, ...spec.env };
  delete env.DOTFILES_CHECKOUT;
  const result = await runner(spec.command, spec.args, { cwd, env, timeoutMs: spec.timeoutMs ?? defaultTimeoutMs });
  const duration_ms = Math.round(performance.now() - started);
  if (result.timedOut) return { status: "timed_out", required: spec.required, duration_ms, error: `timed out after ${spec.timeoutMs ?? defaultTimeoutMs}ms` };
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { status: "unavailable", required: spec.required, duration_ms, error: `${spec.command} is unavailable` };
  }
  const allowed = spec.allowedStatuses ?? [0];
  if (result.error || !allowed.includes(result.status)) {
    const diagnostic = sanitizeDiagnostic(result.stderr || result.error?.message || result.stdout);
    return { status: "failed", required: spec.required, duration_ms, error: diagnostic || `exit ${result.status}` };
  }
  try {
    return { status: "ok", required: spec.required, duration_ms, value: spec.parse(result) };
  } catch (error) {
    return { status: "failed", required: spec.required, duration_ms, error: error instanceof Error ? error.message : String(error) };
  }
}

function backlogCount(probes: Record<string, ProbeResult>): number {
  let count = 0;
  const brew = probes.brew_outdated_greedy?.value;
  if (isRecord(brew)) {
    count += Array.isArray(brew.formulae) ? brew.formulae.length : 0;
    count += Array.isArray(brew.casks) ? brew.casks.length : 0;
  }
  for (const id of ["mise_outdated", "npm_outdated"]) {
    const value = probes[id]?.value;
    if (isRecord(value)) count += Object.keys(value).length;
  }
  const mas = probes.mas_outdated?.value;
  if (Array.isArray(mas)) count += mas.length;
  return count;
}

export async function collectMaintenanceSnapshot(
  context: MaintenanceContext,
  runner: CommandRunner = runProcess,
  macosUpdateIO: MacOSUpdateIO = defaultMacOSUpdateIO,
) {
  const hostOwner = context.ownsHomebrew || context.profileConfig.capabilities.workstation;
  const inventory = hostOwner && context.platform === "darwin"
    ? collectMacOSUpdateInventory({
        cwd: context.cwd,
        env: context.env,
        fresh: context.fresh || context.verify,
        home: context.home,
      }, runner, macosUpdateIO)
    : undefined;
  const [entries, macosUpdates] = await Promise.all([
    Promise.all(buildProbes(context).map(async (spec) => [spec.id, await runProbe(spec, context, runner)] as const)),
    inventory,
  ]);
  const probes: MaintenanceProbes = {};
  for (const [id, result] of entries) probes[id] = result;
  if (macosUpdates) {
    probes.software_update = {
      status: macosUpdates.applicability.status === "unknown" ? "failed" : "ok",
      required: true,
      duration_ms: macosUpdates.duration_ms,
      value: macosUpdates,
      ...(macosUpdates.applicability.status === "unknown" ? { error: "macOS update applicability could not be established" } : {}),
    };
  }
  const backlog_count = backlogCount(probes);
  const required_failures = Object.values(probes).filter((result) => result.required && result.status !== "ok").length;
  const software = macosUpdates as MacOSUpdateInventory | undefined;
  const software_update_status = software?.applicability.status ?? "not_applicable";
  const software_update_available = software?.applicability.status === "updates_available";
  return {
    schema_version: 2,
    collected_at: new Date().toISOString(),
    identity: { host: context.hostname, user: context.user, profile: context.profile },
    capabilities: context.profileConfig.capabilities,
    checkout: checkoutPath(context) ?? null,
    skills: skillFacts(context),
    summary: {
      status: required_failures > 0 ? "incomplete" : backlog_count > 0 || software_update_available ? "attention" : "clean",
      backlog_count,
      required_failures,
      software_update_status,
      software_update_available,
    },
    probes,
  };
}

export function runProcess(command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number | null }): Promise<RawCommandResult> {
  return new Promise((finish) => {
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const complete = (result: RawCommandResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      finish(result);
    };
    if (options.timeoutMs !== null) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutMs);
    }
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => complete({ status: 127, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), error, timedOut }));
    child.on("close", (status) => complete({ status: status ?? 1, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), timedOut }));
  });
}

function ownsHomebrew(env: NodeJS.ProcessEnv): boolean {
  const result = spawnSync("brew", ["--prefix"], { encoding: "utf8", env });
  if (result.status !== 0) return false;
  try {
    return statSync(result.stdout.trim()).uid === (process.getuid?.() ?? -1);
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.some((argument) => argument !== "--fresh" && argument !== "--verify") || new Set(args).size !== args.length) {
    process.stderr.write("Usage: scripts/maintenance/check.ts [--fresh] [--verify]\n");
    return 2;
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const home = process.env.HOME || homedir();
  const profile = readFileSync(join(home, ".config/dotfiles/profile"), "utf8").trim();
  const model = readProfileModel(join(repoRoot, "chezmoi/.chezmoidata/profiles.json"));
  const snapshot = await collectMaintenanceSnapshot({
    cwd: repoRoot,
    env: process.env,
    home,
    hostname: hostname(),
    ownsHomebrew: ownsHomebrew(process.env),
    platform: process.platform,
    profile,
    profileConfig: requireProfile(model, profile),
    repoRoot,
    user: process.env.USER || "unknown",
    fresh: args.includes("--fresh"),
    verify: args.includes("--verify"),
  });
  process.stdout.write(`${JSON.stringify(snapshot)}\n`);
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runMain(Effect.tryPromise({ try: main, catch: (error) => error }).pipe(
    Effect.tap((status) => Effect.sync(() => { process.exitCode = status; })),
    Effect.asVoid,
  ));
}
