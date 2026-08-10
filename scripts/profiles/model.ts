import { readFileSync } from "node:fs";

const capabilityNames = [
  "developer",
  "workload",
  "sharedHomebrew",
  "requiresSopsIdentity",
  "devbox",
  "workstation",
  "personal",
  "zed",
  "githubAppAuth",
] as const;
const profileFields = ["capabilities", "brewfiles", "runtimeGroup", "skillLayers", "installSteps"];
const runtimeGroups = new Set(["developer", "assistant", "none"]);
const skillLayers = new Set(["shared", "personal"]);

export type SkillLayer = "shared" | "personal";

export type ProfileConfig = {
  capabilities: Record<string, boolean>;
  brewfiles: string[];
  runtimeGroup: "developer" | "assistant" | "none";
  skillLayers: SkillLayer[];
  installSteps: string[];
};

export type ProfileModel = {
  version: 1;
  profiles: Record<string, ProfileConfig>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRuntimeGroup(value: string): value is ProfileConfig["runtimeGroup"] {
  return runtimeGroups.has(value);
}

function isSkillLayer(value: string): value is ProfileConfig["skillLayers"][number] {
  return skillLayers.has(value);
}

function readStrings(value: unknown, label: string, allowEmpty = false): string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    !value.every((item) => typeof item === "string" && item.length > 0) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${label} must be a ${allowEmpty ? "unique" : "non-empty unique"} string array`);
  }
  return value;
}

function readProfile(name: string, value: unknown): ProfileConfig {
  if (!isRecord(value) || !hasExactKeys(value, profileFields)) {
    throw new Error(`profile ${name} has an invalid shape`);
  }
  if (!isRecord(value.capabilities) || !hasExactKeys(value.capabilities, capabilityNames)) {
    throw new Error(`profile ${name} capabilities have an invalid shape`);
  }
  const capabilities: Record<string, boolean> = {};
  for (const capability of capabilityNames) {
    const capabilityValue = value.capabilities[capability];
    if (typeof capabilityValue !== "boolean") {
      throw new Error(`profile ${name} capability ${capability} must be boolean`);
    }
    capabilities[capability] = capabilityValue;
  }

  const brewfiles = readStrings(value.brewfiles, `profile ${name} brewfiles`);
  const layers = readStrings(value.skillLayers, `profile ${name} skillLayers`, true);
  const installSteps = readStrings(value.installSteps, `profile ${name} installSteps`);
  if (typeof value.runtimeGroup !== "string" || !isRuntimeGroup(value.runtimeGroup)) {
    throw new Error(`profile ${name} runtimeGroup is invalid`);
  }
  if (!layers.every(isSkillLayer)) {
    throw new Error(`profile ${name} skillLayers contains an unknown layer`);
  }
  if (brewfiles[0] !== "Brewfile" || installSteps[0] !== "apply-dotfiles") {
    throw new Error(`profile ${name} must start with the shared Brewfile and apply-dotfiles step`);
  }

  if (capabilities.developer !== (value.runtimeGroup === "developer") || capabilities.developer !== (layers.length > 0)) {
    throw new Error(`profile ${name} developer capability, runtime group, and skill layers disagree`);
  }

  return {
    capabilities,
    brewfiles,
    runtimeGroup: value.runtimeGroup,
    skillLayers: layers,
    installSteps,
  };
}

export function parseProfileModel(contents: string): ProfileModel {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`profile model is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, ["profileModel"]) || !isRecord(parsed.profileModel)) {
    throw new Error("profile model root has an invalid shape");
  }
  const model = parsed.profileModel;
  if (!hasExactKeys(model, ["version", "profiles"]) || model.version !== 1 || !isRecord(model.profiles)) {
    throw new Error("profile model must contain version 1 and a profiles object");
  }

  const profiles = Object.fromEntries(
    Object.entries(model.profiles).map(([name, value]) => {
      if (!/^[a-z][a-z-]*$/.test(name)) {
        throw new Error(`profile name ${name} is invalid`);
      }
      return [name, readProfile(name, value)];
    }),
  );
  if (Object.keys(profiles).length === 0) {
    throw new Error("profile model must contain at least one profile");
  }
  return { version: 1, profiles };
}

export function readProfileModel(path: string): ProfileModel {
  return parseProfileModel(readFileSync(path, "utf8"));
}

export function requireProfile(model: ProfileModel, name: string): ProfileConfig {
  const profile = model.profiles[name];
  if (!profile) {
    throw new Error(`unknown profile ${name || "<empty>"}`);
  }
  return profile;
}
