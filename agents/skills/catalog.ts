import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import type { AgentLayer } from "../../profiles/model.ts";
import { readLockFile } from "../lock.ts";
import { errorMessage } from "../runtime.ts";

const Skill = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)),
  source: Schema.NonEmptyString,
});
export type Skill = typeof Skill.Type;

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
    !parsed.skills.every(Schema.is(Skill))
  ) {
    throw new Error(
      `Invalid skills manifest at ${manifestPath}: expected non-empty name/source strings`,
    );
  }

  const names = parsed.skills.map((skill) => skill.name);
  if (new Set(names).size !== names.length) {
    throw new Error(`Invalid skills manifest at ${manifestPath}: skill names must be unique`);
  }

  return parsed.skills;
}

export function readLayeredSkills(
  repoDir: string,
  profile: string,
  layers: readonly AgentLayer[],
): { layers: readonly AgentLayer[]; skills: Skill[] } {
  if (layers.length === 0) {
    throw new Error(`Profile ${profile} does not manage agent skills`);
  }

  const manifests = new Map<AgentLayer, Skill[]>();
  for (const layer of ["developer", "workstation", "devbox", "personal"] as const) {
    const manifestPath = join(repoDir, "agents", "skills", `${layer}.json`);
    manifests.set(layer, readSkills(manifestPath));
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

export function readSkillLock(lockPath: string): Skill[] | undefined {
  const parsed = readLockFile(lockPath, "skills");
  if (parsed === undefined) {
    return undefined;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("skills" in parsed) ||
    !Array.isArray(parsed.skills) ||
    !parsed.skills.every(Schema.is(Skill))
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
