#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SKILLS_CLI_VERSION = "1.5.7";
const MAX_DIAGNOSTIC_LENGTH = 600;
const MAX_DIAGNOSTIC_LINES = 3;

type Agent = "claude-code" | "codex";

type Skill = {
  name: string;
  source: string;
};

type SkillFailure = {
  diagnostic: string;
  summary: string;
};

type SkillLock = {
  version: 1;
  skills: Skill[];
};

type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

type StreamMode = "capture" | "ignore" | "inherit";

type RunOptions = {
  stdout?: StreamMode;
  stderr?: StreamMode;
};

type Writer = {
  write(message: string): unknown;
};

export type Runtime = {
  env: NodeJS.ProcessEnv;
  stdout: Writer;
  stderr: Writer;
  commandExists(command: string): boolean;
  run(command: string, args: readonly string[], options?: RunOptions): CommandResult;
};

function stream(mode: StreamMode | undefined): "ignore" | "inherit" | "pipe" {
  return mode === "capture" ? "pipe" : (mode ?? "inherit");
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableNames(command: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") {
    return [command];
  }

  const extensions = (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";");
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

export function createRuntime(env: NodeJS.ProcessEnv = process.env): Runtime {
  return {
    env,
    stdout: process.stdout,
    stderr: process.stderr,
    commandExists(command) {
      const names = executableNames(command, env);
      return (env.PATH ?? "")
        .split(delimiter)
        .filter((directory) => directory.length > 0)
        .some((directory) => names.some((name) => isExecutable(join(directory, name))));
    },
    run(command, args, options = {}) {
      const result = spawnSync(command, args, {
        encoding: "utf8",
        env,
        stdio: ["ignore", stream(options.stdout), stream(options.stderr)],
      });

      return {
        status: result.status ?? 127,
        stdout: typeof result.stdout === "string" ? result.stdout : "",
        stderr: result.error?.message ?? (typeof result.stderr === "string" ? result.stderr : ""),
      };
    },
  };
}

function writeLine(writer: Writer, message: string): void {
  writer.write(`${message}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}

function requireSuccess(result: CommandResult, operation: string): void {
  if (result.status === 0) {
    return;
  }

  const detail = result.stderr.trim();
  throw new Error(`${operation} failed with exit ${result.status}${detail ? `: ${detail}` : ""}`);
}

function gitValue(runtime: Runtime, repoDir: string, args: readonly string[], operation: string): string {
  const result = runtime.run("git", ["-C", repoDir, ...args], {
    stdout: "capture",
    stderr: "capture",
  });
  requireSuccess(result, operation);

  const value = result.stdout.trim();
  if (value.length === 0) {
    throw new Error(`${operation} returned an empty value`);
  }
  return value;
}

function requireCanonicalCheckout(runtime: Runtime, repoDir: string): void {
  const gitDir = resolve(
    repoDir,
    gitValue(runtime, repoDir, ["rev-parse", "--git-dir"], "Finding Git metadata"),
  );
  const commonDir = resolve(
    repoDir,
    gitValue(runtime, repoDir, ["rev-parse", "--git-common-dir"], "Finding shared Git metadata"),
  );
  if (gitDir !== commonDir) {
    throw new Error(
      `Sync must run from the primary checkout, not a linked worktree. Run it from ${dirname(commonDir)}.`,
    );
  }

  const branch = gitValue(
    runtime,
    repoDir,
    ["rev-parse", "--abbrev-ref", "HEAD"],
    "Finding the current branch",
  );
  if (branch !== "main") {
    throw new Error(`Sync must run from the main branch; current branch is ${branch}.`);
  }
}

function requireCleanTrackedCheckout(runtime: Runtime, repoDir: string): void {
  const result = runtime.run(
    "git",
    ["-C", repoDir, "status", "--porcelain=v1", "--untracked-files=no"],
    { stdout: "capture", stderr: "capture" },
  );
  requireSuccess(result, "Checking the dotfiles repository for tracked changes");

  const changes = result.stdout.trim();
  if (changes.length > 0) {
    throw new Error(
      "Sync requires a clean tracked checkout before pulling. Commit, stash, or restore these changes:\n" +
        changes,
    );
  }
}

function requireUpstreamHead(runtime: Runtime, repoDir: string): void {
  const head = gitValue(runtime, repoDir, ["rev-parse", "HEAD"], "Finding the local HEAD");
  const upstream = gitValue(
    runtime,
    repoDir,
    ["rev-parse", "@{upstream}"],
    "Finding the upstream HEAD",
  );

  if (head !== upstream) {
    throw new Error(
      `Local main must exactly match its upstream after pulling (local ${head}, upstream ${upstream}). ` +
        "Publish or reconcile the local commits, then rerun sync.",
    );
  }
}

function isSkill(value: unknown): value is Skill {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.name) &&
    "source" in value &&
    typeof value.source === "string" &&
    value.source.length > 0
  );
}

function readSkills(manifestPath: string): Skill[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid skills manifest at ${manifestPath}: ${errorMessage(error)}`);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("skills" in parsed) ||
    !Array.isArray(parsed.skills) ||
    !parsed.skills.every(isSkill)
  ) {
    throw new Error(`Invalid skills manifest at ${manifestPath}: expected non-empty name/source strings`);
  }

  const names = parsed.skills.map((skill) => skill.name);
  if (new Set(names).size !== names.length) {
    throw new Error(`Invalid skills manifest at ${manifestPath}: skill names must be unique`);
  }

  return parsed.skills;
}

function readSkillLock(lockPath: string): Skill[] | undefined {
  if (!existsSync(lockPath)) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid managed skills lock at ${lockPath}: ${errorMessage(error)}`);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("skills" in parsed) ||
    !Array.isArray(parsed.skills) ||
    !parsed.skills.every(isSkill)
  ) {
    throw new Error(
      `Invalid managed skills lock at ${lockPath}: expected version 1 and safe name/source entries`,
    );
  }

  const names = parsed.skills.map((skill) => skill.name);
  if (new Set(names).size !== names.length) {
    throw new Error(`Invalid managed skills lock at ${lockPath}: skill names must be unique`);
  }

  return parsed.skills;
}

function writeSkillLock(lockPath: string, skills: readonly Skill[]): void {
  mkdirSync(dirname(lockPath), { recursive: true });
  const temporaryDirectory = mkdtempSync(join(dirname(lockPath), ".skills-lock-"));
  const temporaryLock = join(temporaryDirectory, "skills.lock.json");
  const lock: SkillLock = { version: 1, skills: [...skills] };

  try {
    writeFileSync(temporaryLock, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryLock, lockPath);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

function replaceSymlinkAtomically(target: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  const temporaryDirectory = mkdtempSync(join(dirname(destination), ".agents-rules-link-"));
  const temporaryLink = join(temporaryDirectory, "link");

  try {
    symlinkSync(target, temporaryLink);
    renameSync(temporaryLink, destination);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

function migrateLocalRules(repoDir: string, runtime: Runtime): string {
  const agentsDir = join(repoDir, "scripts", "agents");
  const localRules = join(agentsDir, "rules", "local.md");
  const legacyLocalRules = join(agentsDir, "rules.local.md");

  if (existsSync(localRules) && existsSync(legacyLocalRules)) {
    throw new Error(
      `Both ${localRules} and legacy ${legacyLocalRules} exist. Merge them into ${localRules}, remove the legacy file, and rerun sync.`,
    );
  }

  if (existsSync(legacyLocalRules)) {
    mkdirSync(dirname(localRules), { recursive: true });
    renameSync(legacyLocalRules, localRules);
    writeLine(runtime.stdout, "Migrated: scripts/agents/rules.local.md -> scripts/agents/rules/local.md");
  }

  return localRules;
}

function generateRules(repoDir: string, localRules: string): string {
  const rulesDir = join(repoDir, "scripts", "agents", "rules");
  const baseRules = join(rulesDir, "base.md");
  const finalRules = join(rulesDir, "final.md");
  const header =
    "<!-- Generated by scripts/agents/sync.ts from scripts/agents/rules/base.md and optional scripts/agents/rules/local.md. Do not edit directly. -->\n\n";
  const localOverrides = existsSync(localRules)
    ? `\n---\n\n## Local Overrides\n\n${readFileSync(localRules, "utf8")}`
    : "";
  const temporaryDirectory = mkdtempSync(join(dirname(finalRules), ".agents-final-"));
  const temporaryRules = join(temporaryDirectory, "agents.final.md");

  try {
    writeFileSync(temporaryRules, `${header}${readFileSync(baseRules, "utf8")}${localOverrides}`);
    renameSync(temporaryRules, finalRules);
    return finalRules;
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

type AgentLink = {
  agent: Agent;
  destination: string;
  label: string;
};

function findAgentLinks(runtime: Runtime, home: string): AgentLink[] {
  const links: AgentLink[] = [];

  if (runtime.commandExists("claude")) {
    links.push({
      agent: "claude-code",
      destination: join(home, ".claude", "CLAUDE.md"),
      label: "~/.claude/CLAUDE.md",
    });
  } else {
    writeLine(runtime.stdout, "Skipping Claude Code setup: 'claude' is not installed");
  }

  if (runtime.commandExists("codex")) {
    links.push({
      agent: "codex",
      destination: join(home, ".codex", "AGENTS.md"),
      label: "~/.codex/AGENTS.md",
    });
  } else {
    writeLine(runtime.stdout, "Skipping Codex setup: 'codex' is not installed");
  }

  return links;
}

function unmanagedLinkReason(destination: string, targets: readonly string[]): string | undefined {
  try {
    const status = lstatSync(destination);
    if (!status.isSymbolicLink()) {
      return "it is not a symbolic link";
    }

    const currentTarget = readlinkSync(destination);
    if (!targets.map((target) => resolve(target)).includes(resolve(dirname(destination), currentTarget))) {
      return `it points to ${currentTarget}`;
    }
    return undefined;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function preflightAgentLinks(
  links: readonly AgentLink[],
  finalRules: string,
  ...managedTargets: readonly string[]
): void {
  const allowedTargets = [finalRules, ...managedTargets];
  const conflicts = links.flatMap((link) => {
    const reason = unmanagedLinkReason(link.destination, allowedTargets);
    return reason === undefined ? [] : [`${link.destination}: ${reason}`];
  });

  if (conflicts.length > 0) {
    throw new Error(
      "Refusing to replace unmanaged global agent rules:\n" +
        conflicts.map((conflict) => `  - ${conflict}`).join("\n") +
        `\nMove the listed paths aside or link them to ${finalRules}, then rerun sync.`,
    );
  }
}

function configureAgents(runtime: Runtime, links: readonly AgentLink[], finalRules: string): Agent[] {
  for (const link of links) {
    replaceSymlinkAtomically(finalRules, link.destination);
    writeLine(runtime.stdout, `Linked: ${link.label} -> scripts/agents/rules/final.md`);
  }

  return links.map((link) => link.agent);
}

function sanitizeDiagnostic(stderr: string): string {
  const lines = stderr
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-MAX_DIAGNOSTIC_LINES)
    .map((line) =>
      line
        .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, "//[REDACTED]@")
        .replace(/((?:authorization|api[-_ ]?key|password|secret|token)\s*[=:]\s*).+$/gi, "$1[REDACTED]")
        .replace(
          /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g,
          "[REDACTED]",
        ),
    );
  const diagnostic = lines.join("\n");
  if (diagnostic.length <= MAX_DIAGNOSTIC_LENGTH) {
    return diagnostic;
  }
  return `${diagnostic.slice(0, MAX_DIAGNOSTIC_LENGTH - 3)}...`;
}

function installedSkillError(home: string, skill: Skill): string | undefined {
  const manifestPath = join(home, ".agents", "skills", skill.name, "SKILL.md");
  if (!existsSync(manifestPath)) {
    return `installer reported success but ${manifestPath} is missing`;
  }

  const manifest = readFileSync(manifestPath, "utf8");
  const frontmatter = manifest.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (frontmatter === null) {
    return `installer reported success but ${manifestPath} has no YAML frontmatter`;
  }

  const name = frontmatter[1]
    ?.split(/\r?\n/)
    .find((line) => line.startsWith("name:"))
    ?.slice("name:".length)
    .trim();
  if (name !== skill.name) {
    return `installer reported success but ${manifestPath} declares name ${name ?? "<missing>"}`;
  }

  return undefined;
}

function installSkills(
  runtime: Runtime,
  skills: readonly Skill[],
  agents: readonly Agent[],
  cliVersion: string,
  home: string,
): number {
  const failures: SkillFailure[] = [];

  for (const skill of skills) {
    writeLine(runtime.stdout, `Installing skill: ${skill.name} from ${skill.source}`);
    const result = runtime.run(
      "pnpm",
      [
        "dlx",
        `skills@${cliVersion}`,
        "add",
        skill.source,
        "-g",
        "-y",
        "-a",
        ...agents,
        "-s",
        skill.name,
      ],
      { stdout: "capture", stderr: "capture" },
    );

    if (result.status !== 0) {
      failures.push({
        diagnostic: sanitizeDiagnostic(`${result.stdout}\n${result.stderr}`),
        summary: `${skill.name} (${skill.source}, exit ${result.status})`,
      });
      continue;
    }

    const artifactError = installedSkillError(home, skill);
    if (artifactError !== undefined) {
      failures.push({
        diagnostic: artifactError,
        summary: `${skill.name} (${skill.source}, invalid installed artifact)`,
      });
    }
  }

  if (failures.length === 0) {
    return 0;
  }

  const noun = failures.length === 1 ? "skill" : "skills";
  writeLine(runtime.stderr, `Skill installation failed for ${failures.length} ${noun}:`);
  for (const failure of failures) {
    writeLine(runtime.stderr, `  - ${failure.summary}`);
    for (const line of failure.diagnostic.split("\n")) {
      if (line.length > 0) {
        writeLine(runtime.stderr, `    ${line}`);
      }
    }
  }
  writeLine(runtime.stderr, "Fix the reported installer failures, then rerun sync.");
  return 1;
}

function updateGlobalSkills(runtime: Runtime, cliVersion: string): number {
  writeLine(runtime.stdout, "Updating globally installed skills...");
  const result = runtime.run(
    "pnpm",
    ["dlx", `skills@${cliVersion}`, "update", "-g", "-y"],
    { stdout: "inherit", stderr: "inherit" },
  );

  if (result.status === 0) {
    return 0;
  }

  writeLine(
    runtime.stderr,
    `Global skill update failed (exit ${result.status}). Manifest sync already completed; fix the updater and rerun with --update.`,
  );
  return 1;
}

function removeSkills(
  runtime: Runtime,
  skills: readonly Skill[],
  cliVersion: string,
  home: string,
): number {
  const failures: SkillFailure[] = [];

  for (const skill of skills) {
    writeLine(runtime.stdout, `Removing stale managed skill: ${skill.name}`);
    const result = runtime.run(
      "pnpm",
      [
        "dlx",
        `skills@${cliVersion}`,
        "remove",
        skill.name,
        "-g",
        "-y",
      ],
      { stdout: "capture", stderr: "capture" },
    );

    if (result.status !== 0) {
      failures.push({
        diagnostic: sanitizeDiagnostic(`${result.stdout}\n${result.stderr}`),
        summary: `${skill.name} (exit ${result.status})`,
      });
      continue;
    }

    const skillDirectory = join(home, ".agents", "skills", skill.name);
    if (existsSync(skillDirectory)) {
      failures.push({
        diagnostic: `remover reported success but ${skillDirectory} still exists`,
        summary: `${skill.name} (invalid removal result)`,
      });
    }
  }

  if (failures.length === 0) {
    return 0;
  }

  const noun = failures.length === 1 ? "skill" : "skills";
  writeLine(runtime.stderr, `Managed skill removal failed for ${failures.length} ${noun}:`);
  for (const failure of failures) {
    writeLine(runtime.stderr, `  - ${failure.summary}`);
    for (const line of failure.diagnostic.split("\n")) {
      if (line.length > 0) {
        writeLine(runtime.stderr, `    ${line}`);
      }
    }
  }
  writeLine(runtime.stderr, "Fix the reported removal failures, then rerun sync.");
  return 1;
}

type SyncOptions = {
  update: boolean;
};

type ParsedArgs =
  | { kind: "run"; options: SyncOptions }
  | { kind: "help" }
  | { kind: "error"; message: string };

const USAGE = "Usage: ./scripts/agents/sync.ts [--update]";

export function parseArgs(args: readonly string[]): ParsedArgs {
  let update = false;

  for (const arg of args) {
    if (arg === "--update") {
      update = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { kind: "help" };
    }
    return { kind: "error", message: `${USAGE}\nUnknown argument: ${arg}` };
  }

  return { kind: "run", options: { update } };
}

function finishSync(runtime: Runtime, options: SyncOptions, cliVersion: string): number {
  if (options.update) {
    const status = updateGlobalSkills(runtime, cliVersion);
    if (status !== 0) {
      return status;
    }
  }

  writeLine(runtime.stdout, "Done.");
  return 0;
}

function sync(runtime: Runtime, options: SyncOptions): number {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoResult = runtime.run("git", ["-C", scriptDir, "rev-parse", "--show-toplevel"], {
    stdout: "capture",
    stderr: "capture",
  });
  requireSuccess(repoResult, "Finding the dotfiles repository");

  const repoDir = repoResult.stdout.trim();
  if (repoDir.length === 0) {
    throw new Error("Finding the dotfiles repository returned an empty path");
  }
  requireCanonicalCheckout(runtime, repoDir);
  requireCleanTrackedCheckout(runtime, repoDir);

  const home = runtime.env.HOME;
  if (!home) {
    throw new Error("HOME is required to link agent rules");
  }

  const cliVersion = runtime.env.SKILLS_CLI_VERSION || DEFAULT_SKILLS_CLI_VERSION;

  writeLine(runtime.stdout, `Pulling latest in ${repoDir}...`);
  requireSuccess(
    runtime.run("git", ["-C", repoDir, "pull", "--ff-only"]),
    "Fast-forwarding the dotfiles repository",
  );
  requireUpstreamHead(runtime, repoDir);

  const manifestPath = join(repoDir, "scripts", "agents", "skills.json");
  const skills = existsSync(manifestPath) ? readSkills(manifestPath) : undefined;
  const skillLockPath = join(repoDir, "scripts", "agents", "skills.lock.json");
  const previouslyManagedSkills = skills === undefined ? undefined : readSkillLock(skillLockPath);
  const agentsDir = join(repoDir, "scripts", "agents");
  const finalRules = join(agentsDir, "rules", "final.md");
  const previousFinalRules = join(agentsDir, "rules.final.md");
  const legacyFinalRules = join(dirname(repoDir), "agents", "rules", "agents.final.md");
  const links = findAgentLinks(runtime, home);
  preflightAgentLinks(links, finalRules, previousFinalRules, legacyFinalRules);

  const localRules = migrateLocalRules(repoDir, runtime);
  generateRules(repoDir, localRules);
  writeLine(runtime.stdout, "Generated: scripts/agents/rules/final.md");
  const agents = configureAgents(runtime, links, finalRules);
  rmSync(previousFinalRules, { force: true });

  if (skills === undefined) {
    writeLine(runtime.stdout, `No skills manifest found at ${manifestPath}`);
    return finishSync(runtime, options, cliVersion);
  }

  writeLine(runtime.stdout, `Using skills manifest: ${manifestPath}`);
  if (agents.length === 0) {
    writeLine(runtime.stdout, "No supported agent installations found; skipping skill installation");
  } else {
    writeLine(runtime.stdout, `Installing skills for agents: ${agents.join(" ")}`);
    const status = installSkills(runtime, skills, agents, cliVersion, home);
    if (status !== 0) {
      return status;
    }
  }

  const currentNames = new Set(skills.map((skill) => skill.name));
  if (previouslyManagedSkills === undefined) {
    if (agents.length === 0) {
      writeLine(runtime.stdout, "No managed skills lock found; skipping ownership initialization");
      return finishSync(runtime, options, cliVersion);
    }
    writeLine(runtime.stdout, "Initializing managed skills lock without removing existing skills");
  } else {
    const staleSkills = previouslyManagedSkills.filter((skill) => !currentNames.has(skill.name));
    const removalStatus = removeSkills(runtime, staleSkills, cliVersion, home);
    if (removalStatus !== 0) {
      return removalStatus;
    }
  }

  const managedSkills =
    agents.length === 0 && previouslyManagedSkills !== undefined
      ? previouslyManagedSkills.filter((skill) => currentNames.has(skill.name))
      : skills;
  writeSkillLock(skillLockPath, managedSkills);

  return finishSync(runtime, options, cliVersion);
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
    return sync(runtime, parsed.options);
  } catch (error) {
    writeLine(runtime.stderr, `Sync failed: ${errorMessage(error)}`);
    return 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
