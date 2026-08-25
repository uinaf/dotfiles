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
  createRuntime,
  errorMessage,
  resolveProfileName,
  type Runtime,
  sanitizeDiagnostic,
  writeLine,
} from "./runtime.ts";

export { createRuntime, type Runtime } from "./runtime.ts";

const DEFAULT_SKILLS_CLI_VERSION = "1.5.7";

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

function assertUniqueSkillNames(skills: readonly Skill[], manifestPath: string): void {
  const names = new Set<string>();
  for (const skill of skills) {
    if (names.has(skill.name)) {
      throw new Error(
        `Invalid skills manifest at ${manifestPath}: ${skill.name} is defined more than once`,
      );
    }
    names.add(skill.name);
  }
}

function readLayeredSkills(
  repoDir: string,
  profile: string,
  layers: readonly SkillLayer[],
): { layers: readonly SkillLayer[]; skills: Skill[] } {
  if (layers.length === 0) {
    throw new Error(`Profile ${profile} does not manage agent skills`);
  }

  const manifests = new Map<SkillLayer, Skill[]>();
  for (const layer of ["developer", "workstation", "devbox", "personal"] as const) {
    const manifestPath = join(repoDir, "scripts", "agents", "skills", `${layer}.json`);
    const skillsForLayer = readSkills(manifestPath);
    assertUniqueSkillNames(skillsForLayer, manifestPath);
    manifests.set(layer, skillsForLayer);
  }

  const sources = new Map<string, string>();
  const skills: Skill[] = [];
  for (const skill of layers.flatMap((layer) => manifests.get(layer) ?? [])) {
    const previousSource = sources.get(skill.name);
    if (previousSource === skill.source) {
      continue; // the same skill selected by more than one composed layer
    }
    if (previousSource !== undefined) {
      throw new Error(
        `Invalid layered skills: ${skill.name} is defined more than once (${previousSource} and ${skill.source})`,
      );
    }
    sources.set(skill.name, skill.source);
    skills.push(skill);
  }

  return { layers, skills };
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

function findInstalledAgents(runtime: Runtime): Agent[] {
  const agents: Agent[] = [];

  if (runtime.commandExists("claude")) {
    agents.push("claude-code");
  } else {
    writeLine(runtime.stdout, "Skipping Claude Code skills: 'claude' is not installed");
  }

  if (runtime.commandExists("codex")) {
    agents.push("codex");
  } else {
    writeLine(runtime.stdout, "Skipping Codex skills: 'codex' is not installed");
  }

  return agents;
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
  profile?: string;
  update: boolean;
};

type ParsedArgs =
  | { kind: "run"; options: SyncOptions }
  | { kind: "help" }
  | { kind: "error"; message: string };

const USAGE = "Usage: ./scripts/agents/sync.ts [--profile PROFILE] [--update]";

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
  const repoDir = runtime.repoDir ?? resolve(scriptDir, "../..");
  const profileName = resolveProfileName(runtime, scriptDir, options.profile);

  const home = runtime.env.HOME;
  if (!home) {
    throw new Error("HOME is required to manage agent skills");
  }

  const cliVersion = runtime.env.SKILLS_CLI_VERSION || DEFAULT_SKILLS_CLI_VERSION;

  const model = readProfileModel(resolve(repoDir, "chezmoi/.chezmoidata/profiles.json"));
  const profile = requireProfile(model, profileName);
  const { layers, skills } = readLayeredSkills(repoDir, profileName, profile.skillLayers);
  const skillLockPath = join(repoDir, "scripts", "agents", "skills.lock.json");
  const previouslyManagedSkills = readSkillLock(skillLockPath);
  const agents = findInstalledAgents(runtime);

  writeLine(runtime.stdout, `Profile: ${profileName}`);
  writeLine(runtime.stdout, `Skill layers: ${layers.join(", ")}`);
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
  runMain(Effect.sync(() => { process.exitCode = main(process.argv.slice(2)); }));
}
