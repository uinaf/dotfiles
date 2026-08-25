import { Effect, FileSystem, Schema } from "effect";
import { readFileSync } from "node:fs";

const Capabilities = Schema.Struct({
  developer: Schema.Boolean,
  workload: Schema.Boolean,
  sharedHomebrew: Schema.Boolean,
  requiresSopsIdentity: Schema.Boolean,
  devbox: Schema.Boolean,
  workstation: Schema.Boolean,
  personal: Schema.Boolean,
  githubAppAuth: Schema.Boolean,
});

const SkillLayer = Schema.Literals(["developer", "workstation", "devbox", "personal"]);
const ProfileConfig = Schema.Struct({
  capabilities: Capabilities,
  brewfiles: Schema.NonEmptyArray(Schema.NonEmptyString),
  runtimeGroup: Schema.Literals(["developer", "assistant", "none"]),
  skillLayers: Schema.Array(SkillLayer),
  installSteps: Schema.NonEmptyArray(Schema.NonEmptyString),
});
const ProfileModel = Schema.Struct({
  version: Schema.Literal(1),
  profiles: Schema.Record(Schema.String, ProfileConfig),
});
const ProfileDocument = Schema.Struct({ profileModel: ProfileModel });

export type SkillLayer = typeof SkillLayer.Type;
export type ProfileConfig = typeof ProfileConfig.Type;
export type ProfileModel = typeof ProfileModel.Type;

export class ProfileModelError extends Schema.TaggedError<ProfileModelError>()("ProfileModelError", {
  message: Schema.String,
}) {}

function hasUniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

const validateProfile = Effect.fn("validateProfile")(function*(name: string, profile: ProfileConfig) {
  if (!/^[a-z][a-z-]*$/.test(name)) {
    return yield* new ProfileModelError({ message: `profile name ${name} is invalid` });
  }
  for (const [field, values] of [
    ["brewfiles", profile.brewfiles],
    ["skillLayers", profile.skillLayers],
    ["installSteps", profile.installSteps],
  ] as const) {
    if (!hasUniqueValues(values)) {
      return yield* new ProfileModelError({ message: `profile ${name} ${field} must contain unique values` });
    }
  }
  if (profile.brewfiles[0] !== "Brewfile" || profile.installSteps[0] !== "apply-dotfiles") {
    return yield* new ProfileModelError({ message: `profile ${name} must start with the shared Brewfile and apply-dotfiles step` });
  }
  if (profile.installSteps.includes("install-runtimes") !== (profile.runtimeGroup !== "none")) {
    return yield* new ProfileModelError({ message: `profile ${name} runtime group and install steps disagree` });
  }
  if (profile.installSteps.includes("install-repository-dependencies") !== (profile.runtimeGroup !== "none")) {
    return yield* new ProfileModelError({ message: `profile ${name} runtime group and repository dependency steps disagree` });
  }
  if (profile.installSteps.indexOf("install-repository-dependencies") !== profile.installSteps.indexOf("install-runtimes") + 1) {
    return yield* new ProfileModelError({ message: `profile ${name} must install repository dependencies after runtimes` });
  }
  if (
    profile.capabilities.developer !== (profile.runtimeGroup === "developer") ||
    profile.capabilities.developer !== (profile.skillLayers.length > 0)
  ) {
    return yield* new ProfileModelError({ message: `profile ${name} developer capability, runtime group, and skill layers disagree` });
  }
});

export const parseProfileModelEffect = Effect.fn("parseProfileModel")(function*(contents: string) {
  const parsed = yield* Effect.try({
    try: () => JSON.parse(contents) as unknown,
    catch: (error) => new ProfileModelError({
      message: `profile model is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    }),
  });
  const document = yield* Schema.decodeUnknownEffect(ProfileDocument, {
    errors: "all",
    onExcessProperty: "error",
  })(parsed).pipe(
    Effect.mapError((error) => new ProfileModelError({ message: `profile model has an invalid shape: ${error.message}` })),
  );
  const entries = Object.entries(document.profileModel.profiles);
  if (entries.length === 0) {
    return yield* new ProfileModelError({ message: "profile model must contain at least one profile" });
  }
  yield* Effect.forEach(entries, ([name, profile]) => validateProfile(name, profile));
  return document.profileModel;
});

export const readProfileModelEffect = Effect.fn("readProfileModel")(function*(path: string) {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFileString(path).pipe(
    Effect.mapError((error) => new ProfileModelError({ message: `cannot read profile model ${path}: ${error}` })),
  );
  return yield* parseProfileModelEffect(contents);
});

export function parseProfileModel(contents: string): ProfileModel {
  return Effect.runSync(parseProfileModelEffect(contents));
}

export function readProfileModel(path: string): ProfileModel {
  return parseProfileModel(readFileSync(path, "utf8"));
}

export function requireProfile(model: ProfileModel, name: string): ProfileConfig {
  if (!Object.hasOwn(model.profiles, name)) {
    throw new Error(`unknown profile ${name || "<empty>"}`);
  }
  return model.profiles[name];
}
