import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { findingLocators, sqlitePageStats, summarizeFindings } from "./data.ts";

export type AuditFormat = "text" | "json";
export type FindingSeverity = "ok" | "warn" | "fail";

export type PathSource =
  | { kind: "path"; path: string }
  | { kind: "home-dotfiles"; exclude?: readonly string[] }
  | { kind: "files"; path: string; maxDepth?: number; namePrefix?: string };

export type AuditCheck =
  | { kind: "file-mode"; path: string; modes: readonly number[]; missing: Exclude<FindingSeverity, "ok">; mismatch: Exclude<FindingSeverity, "ok"> }
  | { kind: "pattern-absent"; sources: readonly PathSource[]; pattern: RegExp; label: string; severity: Exclude<FindingSeverity, "ok"> }
  | { kind: "npm-auth-boundary"; path: string }
  | { kind: "secret-scan"; sources: readonly PathSource[] }
  | { kind: "git-identity"; config: string }
  | { kind: "github-auth" }
  | { kind: "ssh-private-key-modes"; path: string }
  | { kind: "codex-log-size"; path: string }
  | { kind: "command-status"; command: string; args: readonly string[]; missing: Exclude<FindingSeverity, "ok">; failure: Exclude<FindingSeverity, "ok">; label: string };

export type AuditPolicy = {
  name: string;
  summary: string;
  sections: readonly { title: string; checks: readonly AuditCheck[] }[];
};

type CommandResult = { status: number | null; stdout: string; stderr: string; error?: Error };
type CommandRunner = (command: string, args: readonly string[]) => CommandResult;
type Finding = { severity: FindingSeverity; message: string };

export type AuditDependencies = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  command?: CommandRunner;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
};

export type AuditSummary = {
  audit: string;
  status: "pass" | "warn" | "fail";
  failed: number;
  warnings: number;
  secret_scan_count: number;
  secret_scan_finding_count: number;
  secret_scan_rules: Record<string, number>;
  secret_scan_severities: Record<string, number>;
};

const privateKeyPattern = /^(-----BEGIN ([A-Z0-9]+ )?PRIVATE KEY-----|---- BEGIN SSH2 (ENCRYPTED )?PRIVATE KEY ----|PuTTY-User-Key-File-[23]:)/m;

class AuditRun {
  readonly findings: Finding[] = [];
  readonly secret = { scanned: 0, findings: 0, rules: {} as Record<string, number>, severities: {} as Record<string, number> };
  readonly policy: AuditPolicy;
  readonly format: AuditFormat;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly command: CommandRunner;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  settings: Record<string, string> = {};

  constructor(
    policy: AuditPolicy,
    format: AuditFormat,
    home: string,
    env: NodeJS.ProcessEnv,
    command: CommandRunner,
    stdout: (value: string) => void,
    stderr: (value: string) => void,
  ) {
    this.policy = policy;
    this.format = format;
    this.home = home;
    this.env = env;
    this.command = command;
    this.stdout = stdout;
    this.stderr = stderr;
  }

  finding(severity: FindingSeverity, message: string): void {
    this.findings.push({ severity, message });
    if (this.format === "json") return;
    const line = `${severity === "fail" ? "FAILED:" : severity} ${message}\n`;
    (severity === "ok" ? this.stdout : this.stderr)(line);
  }

  summary(): AuditSummary {
    const failed = this.findings.filter(({ severity }) => severity === "fail").length;
    const warnings = this.findings.filter(({ severity }) => severity === "warn").length;
    return {
      audit: this.policy.name,
      status: failed > 0 ? "fail" : warnings > 0 ? "warn" : "pass",
      failed,
      warnings,
      secret_scan_count: this.secret.scanned,
      secret_scan_finding_count: this.secret.findings,
      secret_scan_rules: this.secret.rules,
      secret_scan_severities: this.secret.severities,
    };
  }
}

function defaultCommand(command: string, args: readonly string[]): CommandResult {
  const result = spawnSync(command, [...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

function homePath(home: string, path: string): string {
  return path.startsWith("/") ? path : join(home, path);
}

function walkFiles(root: string, maxDepth = Number.POSITIVE_INFINITY, depth = 0): string[] {
  if (!existsSync(root)) return [];
  if (!statSync(root).isDirectory()) return [root];
  if (depth > maxDepth) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() && depth < maxDepth ? walkFiles(path, maxDepth, depth + 1) : entry.isFile() ? [path] : [];
  });
}

export function resolveSources(home: string, sources: readonly PathSource[]): string[] {
  const paths = sources.flatMap((source) => {
    if (source.kind === "path") {
      const path = homePath(home, source.path);
      return existsSync(path) ? [path] : [];
    }
    if (source.kind === "home-dotfiles") {
      const excluded = new Set(source.exclude ?? []);
      return readdirSync(home, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.startsWith(".") && !excluded.has(entry.name))
        .map((entry) => join(home, entry.name));
    }
    const root = homePath(home, source.path);
    return walkFiles(root, source.maxDepth ?? Number.POSITIVE_INFINITY)
      .filter((path) => source.namePrefix === undefined || basename(path).startsWith(source.namePrefix));
  });
  return [...new Set(paths)].sort();
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

function humanBytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount < 10 && unit > 0 ? amount.toFixed(1).replace(/\.0$/, "") : Math.floor(amount)}${units[unit]}`;
}

function checkFileMode(run: AuditRun, check: Extract<AuditCheck, { kind: "file-mode" }>): void {
  const path = homePath(run.home, check.path);
  if (!existsSync(path)) return run.finding(check.missing, `missing ${path}`);
  const mode = modeOf(path);
  if (check.modes.includes(mode)) run.finding("ok", `${path} mode ${mode.toString(8)}`);
  else run.finding(check.mismatch, `${path} mode is ${mode.toString(8)}, expected one of: ${check.modes.map((value) => value.toString(8)).join(" ")}`);
}

function checkPatterns(run: AuditRun, check: Extract<AuditCheck, { kind: "pattern-absent" }>): void {
  for (const path of resolveSources(run.home, check.sources)) {
    try {
      if (check.pattern.test(readFileSync(path, "utf8"))) run.finding(check.severity, `${path} contains ${check.label}`);
      else run.finding("ok", `${path} does not contain ${check.label}`);
    } catch {
      run.finding("warn", `cannot read ${path} for ${check.label}`);
    }
  }
}

function checkNpmAuth(run: AuditRun, pathValue: string): void {
  const path = homePath(run.home, pathValue);
  if (!existsSync(path)) return;
  checkFileMode(run, { kind: "file-mode", path, modes: [0o600], missing: "fail", mismatch: "fail" });
  const unscoped = /^\s*(_auth|_authToken|username|_password|certfile|keyfile)\s*=/m;
  if (unscoped.test(readFileSync(path, "utf8"))) run.finding("fail", `${path} contains auth settings without a registry scope`);
  else run.finding("ok", `${path} does not contain auth settings without a registry scope`);
}

function stagePath(scanRoot: string, home: string, path: string): void {
  const relative = path.startsWith(`${home}/`) ? `home/${path.slice(home.length + 1)}` : path.startsWith("/") ? `root/${path.slice(1)}` : `relative/${path}`;
  const destination = join(scanRoot, relative);
  mkdirSync(dirname(destination), { recursive: true });
  symlinkSync(path, destination);
}

function checkSecretScan(run: AuditRun, sources: readonly PathSource[]): void {
  for (const tool of ["gitleaks", "trufflehog"] as const) {
    const result = run.command(tool, ["--version"]);
    if (result.error?.message.includes("ENOENT")) {
      run.finding("fail", `${tool} is missing for local secret scan`);
      return;
    }
  }

  const paths = resolveSources(run.home, sources);
  run.secret.scanned += paths.length;
  if (paths.length === 0) return run.finding("warn", "no readable local config files found for gitleaks secret scan");

  const temporaryRoot = run.env.TMPDIR || tmpdir();
  mkdirSync(temporaryRoot, { recursive: true });
  const scanRoot = mkdtempSync(join(temporaryRoot, "dotfiles-secret-scan."));
  const reportRoot = mkdtempSync(join(temporaryRoot, "dotfiles-secret-report."));
  const report = join(reportRoot, "gitleaks-report.json");
  try {
    chmodSync(scanRoot, 0o700);
    chmodSync(reportRoot, 0o700);
    writeFileSync(report, "", { mode: 0o600 });
    for (const path of paths) stagePath(scanRoot, run.home, path);

    const gitleaks = run.command("gitleaks", ["dir", "--follow-symlinks", "--redact", "--exit-code", "183", "--no-banner", "--log-level", "error", "--report-format", "json", "--report-path", report, scanRoot]);
    const summary = summarizeFindings(JSON.stringify(run.secret.rules), JSON.stringify(run.secret.severities), report, resolve(import.meta.dirname, "gitleaks-policy.json"));
    run.secret.findings += summary.findingCount;
    run.secret.rules = summary.rules;
    run.secret.severities = summary.severities;

    if (summary.findingCount === 0 && gitleaks.status === 0) run.finding("ok", `gitleaks found no leaks in ${paths.length} local config files`);
    else if (summary.findingCount > 0) {
      if (run.format === "text") {
        for (const locator of findingLocators(scanRoot, report)) run.stderr(`finding rule=${locator.replace("\t", " path=")}\n`);
      }
      run.finding(summary.failures > 0 ? "fail" : "warn", summary.failures > 0
        ? "gitleaks reported findings at or above the failure threshold"
        : "gitleaks reported findings below the failure threshold");
    } else run.finding("fail", "gitleaks local config scan failed");

    const trufflehog = run.command("trufflehog", ["filesystem", "--no-update", "--no-color", "--results=verified", "--fail", "--force-skip-binaries", "--force-skip-archives", "--max-symlink-depth=1", scanRoot]);
    if (trufflehog.status === 0) run.finding("ok", `trufflehog found no verified leaks in ${paths.length} local config files`);
    else if (trufflehog.status === 183) run.finding("fail", "trufflehog reported verified leaks in local config files");
    else run.finding("fail", "trufflehog local config scan failed");
  } catch {
    run.finding("fail", "local secret scan could not stage or classify files safely");
  } finally {
    rmSync(scanRoot, { recursive: true, force: true });
    rmSync(reportRoot, { recursive: true, force: true });
  }
}

function gitValue(run: AuditRun, config: string, key: string): string {
  return run.command("git", ["config", "--file", homePath(run.home, config), "--includes", "--get", key]).stdout.trim();
}

function checkGitIdentity(run: AuditRun, config: string): void {
  const name = gitValue(run, config, "user.name");
  const email = gitValue(run, config, "user.email");
  const signingKey = gitValue(run, config, "user.signingkey");
  const signingEnabled = gitValue(run, config, "commit.gpgsign") === "true";
  run.finding(name && email ? "ok" : "warn", name && email ? "git identity is configured" : "git identity is incomplete");
  run.finding(signingKey ? "ok" : "warn", signingKey ? "git signing key configured" : "git signing key is not configured");
  run.finding(signingEnabled ? "ok" : "warn", signingEnabled ? "git commit signing enabled" : "git commit signing is not enabled");
}

function loadAuditSettings(run: AuditRun): Record<string, string> {
  const path = run.env.AUDIT_POLICY_FILE || join(run.home, ".config/dotfiles/audit.env");
  if (!existsSync(path)) return {};
  const settings: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^#\s]*))\s*$/);
    if (match) settings[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  run.finding("ok", `loaded audit policy from ${path}`);
  return settings;
}

function checkGithubAuth(run: AuditRun): void {
  const status = run.command("gh", ["auth", "status", "-h", "github.com"]);
  if (status.error?.message.includes("ENOENT")) return run.finding("fail", "gh is missing");
  if (status.status !== 0) return run.finding("fail", "gh auth is not working for github.com");
  run.finding("ok", "gh auth works for github.com");
  const sensitive = (run.settings.GH_SENSITIVE_SCOPES || "delete_repo workflow admin:org admin:public_key admin:repo_hook write:packages").split(/\s+/);
  const accepted = new Set((run.settings.GH_ACCEPTED_SCOPES || "").split(/\s+/));
  const scopes = new Set(status.stderr.match(/Token scopes:\s*(.*)/)?.[1].replace(/[',]/g, "").split(/\s+/) ?? []);
  for (const scope of sensitive) {
    if (!scopes.has(scope)) continue;
    run.finding(accepted.has(scope) ? "ok" : "warn", accepted.has(scope)
      ? `gh token broad scope accepted by policy: ${scope}`
      : `gh token has broad scope outside policy: ${scope}`);
  }
}

function checkSshModes(run: AuditRun, pathValue: string): void {
  const root = homePath(run.home, pathValue);
  if (!existsSync(root)) return run.finding("warn", `missing ${root}`);
  for (const path of walkFiles(root)) {
    try {
      if (!privateKeyPattern.test(readFileSync(path, "utf8"))) continue;
      const mode = modeOf(path);
      run.finding((mode & 0o077) === 0 ? "ok" : "fail", (mode & 0o077) === 0
        ? `${path} mode ${mode.toString(8)}`
        : `${path} mode ${mode.toString(8)} is group/world accessible`);
    } catch {
      run.finding("warn", `cannot inspect SSH file ${path}`);
    }
  }
}

function numericEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = Number(env[key]);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function checkLogFile(run: AuditRun, path: string): void {
  const physical = statSync(path).size;
  const failBytes = numericEnv(run.env, "CODEX_LOG_FAIL_BYTES", 524_288_000);
  const warnBytes = numericEnv(run.env, "CODEX_LOG_WARN_BYTES", 209_715_200);
  let stats: [number, number, number] | undefined;
  try { stats = sqlitePageStats(path); } catch {}
  if (!stats) {
    run.finding(physical >= failBytes ? "fail" : physical >= warnBytes ? "warn" : "ok", physical >= warnBytes
      ? `${path} is larger than ${humanBytes(physical >= failBytes ? failBytes : warnBytes)} (physical size; SQLite stats unavailable)`
      : `${path} size is under ${humanBytes(warnBytes)} (physical size; SQLite stats unavailable)`);
    return;
  }
  const [pageSize, pageCount, freelistCount] = stats;
  const live = (pageCount - freelistCount) * pageSize;
  const reclaimable = freelistCount * pageSize;
  const ratio = Math.floor(freelistCount * 100 / pageCount);
  const detail = `physical=${humanBytes(physical)} live=${humanBytes(live)} reclaimable=${humanBytes(reclaimable)} freelist=${ratio}%`;
  if (live >= failBytes) return run.finding("fail", `${path} live data is larger than ${humanBytes(failBytes)} (${detail})`);
  if (live >= warnBytes) run.finding("warn", `${path} live data is larger than ${humanBytes(warnBytes)} (${detail})`);
  const reclaimWarn = numericEnv(run.env, "CODEX_LOG_RECLAIM_WARN_BYTES", 209_715_200);
  const ratioWarn = numericEnv(run.env, "CODEX_LOG_FREELIST_WARN_RATIO", 50);
  const floor = numericEnv(run.env, "CODEX_LOG_RECLAIM_FLOOR_BYTES", 52_428_800);
  const highReclaim = reclaimable >= reclaimWarn || (ratio >= ratioWarn && reclaimable >= floor);
  if (highReclaim) run.finding("warn", `${path} has high reclaimable SQLite space (${detail})`);
  if (live < warnBytes && !highReclaim) run.finding("ok", `${path} size is healthy (${detail})`);
}

function runCheck(run: AuditRun, check: AuditCheck): void {
  switch (check.kind) {
    case "file-mode": return checkFileMode(run, check);
    case "pattern-absent": return checkPatterns(run, check);
    case "npm-auth-boundary": return checkNpmAuth(run, check.path);
    case "secret-scan": return checkSecretScan(run, check.sources);
    case "git-identity": return checkGitIdentity(run, check.config);
    case "github-auth": return checkGithubAuth(run);
    case "ssh-private-key-modes": return checkSshModes(run, check.path);
    case "codex-log-size": {
      const root = homePath(run.home, check.path);
      if (existsSync(root)) for (const path of walkFiles(root, 0).filter((value) => /^logs.*\.sqlite(?:-wal)?$/.test(basename(value)))) checkLogFile(run, path);
      return;
    }
    case "command-status": {
      const result = run.command(check.command, check.args);
      if (result.error?.message.includes("ENOENT")) run.finding(check.missing, `${check.command} CLI is missing`);
      else run.finding(result.status === 0 ? "ok" : check.failure, result.status === 0 ? `${check.label} works` : `${check.label} failed`);
    }
  }
}

export function runPolicy(policy: AuditPolicy, format: AuditFormat, dependencies: AuditDependencies = {}): { status: number; summary: AuditSummary } {
  const run = new AuditRun(
    policy,
    format,
    dependencies.home || dependencies.env?.HOME || process.env.HOME || "",
    { ...process.env, ...dependencies.env },
    dependencies.command || defaultCommand,
    dependencies.stdout || ((value) => process.stdout.write(value)),
    dependencies.stderr || ((value) => process.stderr.write(value)),
  );
  run.settings = loadAuditSettings(run);
  for (const key of ["CODEX_LOG_FAIL_BYTES", "CODEX_LOG_WARN_BYTES", "CODEX_LOG_RECLAIM_WARN_BYTES", "CODEX_LOG_FREELIST_WARN_RATIO", "CODEX_LOG_RECLAIM_FLOOR_BYTES"]) {
    if (run.settings[key] !== undefined) run.env[key] = run.settings[key];
  }
  for (const section of policy.sections) {
    if (format === "text") run.stdout(`\n## ${section.title}\n`);
    for (const check of section.checks) runCheck(run, check);
  }
  const summary = run.summary();
  if (format === "json") run.stdout(`${JSON.stringify(summary)}\n`);
  else run.stdout(`\n${policy.summary}: ${summary.failed} failed, ${summary.warnings} warnings\n`);
  return { status: summary.failed > 0 ? 1 : 0, summary };
}
