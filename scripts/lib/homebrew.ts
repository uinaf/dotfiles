import { Console, Effect, FileSystem, Option, Schema } from "effect";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { runChecked, runCommand } from "./command.ts";
import { CliFailure, fail } from "./program.ts";
import type { ProfileModel } from "../profiles/model.ts";
import { requireProfile } from "../profiles/model.ts";

const PackageName = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9@+._/-]+$/)));
const CommandCapability = Schema.Struct({
  packageType: Schema.Literals(["brew", "cask"]),
  name: PackageName,
  validator: Schema.Literal("command"),
  path: Schema.NonEmptyString,
  arguments: Schema.Array(Schema.String),
});
const BundleCapability = Schema.Struct({
  packageType: Schema.Literal("cask"),
  name: PackageName,
  validator: Schema.Literal("bundle"),
  path: Schema.NonEmptyString,
  bundleIdentifier: Schema.NonEmptyString,
  teamIdentifier: Schema.NonEmptyString,
});
const ExternalHomebrew = Schema.Struct({
  version: Schema.Literal(1),
  capabilities: Schema.Array(Schema.Union([CommandCapability, BundleCapability])),
});

export type HomebrewEnvironment = Readonly<Record<string, string>>;

export const commandAvailable = Effect.fn("homebrewCommandAvailable")(function*(name: string) {
  const fs = yield* FileSystem.FileSystem;
  for (const directory of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    const info = yield* fs.stat(join(directory, name)).pipe(Effect.option);
    if (Option.isSome(info) && info.value.type === "File" && (info.value.mode & 0o111) !== 0) return true;
  }
  return false;
});

const runRaw = runCommand;
const run = runChecked;

export const homebrewPrefix = Effect.fn("homebrewPrefix")(function*() {
  return (yield* run("brew", ["--prefix"])).stdout.trim();
});

export const requirePrefixOwner = Effect.fn("requireHomebrewPrefixOwner")(function*() {
  const fs = yield* FileSystem.FileSystem;
  const prefix = yield* homebrewPrefix();
  const info = yield* fs.stat(prefix).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "Directory") return yield* fail(`Homebrew prefix does not exist: ${prefix}`);
  const ownerUid = Option.getOrUndefined(info.value.uid);
  const currentUid = process.getuid?.();
  if (ownerUid === currentUid) return prefix;
  const owner = yield* runRaw("id", ["-un", String(ownerUid)]);
  const current = yield* run("id", ["-un"]);
  const ownerName = owner.status === 0 ? owner.stdout.trim() : `uid ${ownerUid}`;
  return yield* fail(`Homebrew mutations must run as prefix owner ${ownerName}; current user is ${current.stdout.trim()}`);
});

export const repairSharedReadability = Effect.fn("repairHomebrewSharedReadability")(function*() {
  const prefix = yield* requirePrefixOwner();
  const uid = String(process.getuid?.());
  for (const args of [
    [prefix, "-xdev", "-type", "d", "-uid", uid, "(", "!", "-perm", "-0050", "-o", "-perm", "-0020", ")", "-exec", "chmod", "g+rX,g-w", "{}", "+"],
    [prefix, "-xdev", "-type", "f", "-uid", uid, "(", "!", "-perm", "-0040", "-o", "-perm", "-0020", ")", "-exec", "chmod", "g+r,g-w", "{}", "+"],
    [prefix, "-xdev", "-type", "f", "-uid", uid, "-perm", "-0100", "!", "-perm", "-0010", "-exec", "chmod", "g+x", "{}", "+"],
  ]) yield* run("find", args);
  if (process.platform === "darwin") {
    yield* run("find", [prefix, "-xdev", "-type", "l", "-uid", uid, "(", "!", "-perm", "-0050", "-o", "-perm", "-0020", ")", "-exec", "chmod", "-h", "g+rX,g-w", "{}", "+"]);
  }
});

export const verifyPrefixPermissions = Effect.fn("verifyHomebrewPrefixPermissions")(function*() {
  const fs = yield* FileSystem.FileSystem;
  const prefix = yield* homebrewPrefix();
  const info = yield* fs.stat(prefix).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "Directory") return yield* fail(`Homebrew prefix does not exist: ${prefix}`);
  const ownerUid = String(Option.getOrUndefined(info.value.uid));
  const foreign = yield* run("find", [prefix, "-xdev", "!", "-uid", ownerUid, "-print", "-quit"]);
  if (foreign.stdout.trim()) return yield* fail(`Homebrew prefix contains content not owned by uid ${ownerUid}: ${foreign.stdout.trim()}`);
  const writable = yield* run("find", [prefix, "-xdev", "!", "-type", "l", "-perm", "-0020", "-print", "-quit"]);
  if (writable.stdout.trim()) return yield* fail(`Homebrew prefix contains group-writable content: ${writable.stdout.trim()}`);
});

export function profileBrewfiles(model: ProfileModel, profile: string): readonly string[] {
  return requireProfile(model, profile).brewfiles;
}

export function bundleCheckArgs(model: ProfileModel, profile: string, file: string): readonly string[] {
  const installedOnly = requireProfile(model, profile).capabilities.sharedHomebrew ? ["--no-upgrade"] : [];
  return ["bundle", "check", ...installedOnly, "--file", file];
}

export const composeBrewfile = Effect.fn("composeBrewfile")(function*(repoRoot: string, files: readonly string[]) {
  const fs = yield* FileSystem.FileSystem;
  const composed = yield* fs.makeTempFile({ directory: repoRoot, prefix: "Brewfile.composed." });
  const contents = yield* Effect.forEach(files, (file) => fs.readFileString(join(repoRoot, file)));
  yield* fs.writeFileString(composed, contents.join(""));
  return composed;
});

export const removeComposedBrewfile = Effect.fn("removeComposedBrewfile")(function*(repoRoot: string, composed: string) {
  const fs = yield* FileSystem.FileSystem;
  const parent = dirname(composed);
  if (parent !== repoRoot && basename(parent).startsWith("Brewfile.composed.")) {
    yield* fs.remove(parent, { recursive: true, force: true });
  } else {
    yield* fs.remove(composed, { force: true });
  }
});

export function cleanupFiles(model: ProfileModel, profile: string): readonly string[] {
  if (!requireProfile(model, profile).capabilities.sharedHomebrew) return profileBrewfiles(model, profile);
  return profileBrewfiles(model, "personal-devbox");
}

export function cleanupProfile(model: ProfileModel, profile: string): string {
  return requireProfile(model, profile).capabilities.sharedHomebrew ? "personal-devbox" : profile;
}

export const bundleDrift = Effect.fn("homebrewBundleDrift")(function*(repoRoot: string, model: ProfileModel, profile: string) {
  const fs = yield* FileSystem.FileSystem;
  const composed = yield* composeBrewfile(repoRoot, cleanupFiles(model, profile));
  const result = yield* runRaw("brew", ["bundle", "cleanup", "--file", composed], {
    env: {
      HOMEBREW_BUNDLE_DOTFILES_PROFILE: cleanupProfile(model, profile),
      HOMEBREW_NO_AUTO_UPDATE: "1",
    },
  }).pipe(Effect.ensuring(removeComposedBrewfile(repoRoot, composed).pipe(Effect.orDie)));
  let show = false;
  return result.stdout.split("\n").filter((line) => {
    if (/^Would (uninstall|untap)/.test(line)) show = true;
    if (/^Would `brew cleanup`/.test(line)) show = false;
    return show;
  }).join("\n");
});

export const trustTaps = Effect.fn("trustHomebrewTaps")(function*(repoRoot: string, files: readonly string[]) {
  const support = yield* runRaw("brew", ["trust", "--help"]);
  if (support.status !== 0) return;
  const fs = yield* FileSystem.FileSystem;
  for (const file of files) {
    const contents = yield* fs.readFileString(isAbsolute(file) ? file : join(repoRoot, file));
    for (const line of contents.split("\n")) {
      const tap = /^tap "([^"]+)"/.exec(line)?.[1];
      if (!tap) continue;
      const trusted = yield* runRaw("brew", ["trust", "--tap", tap]);
      if (trusted.status !== 0) {
        return yield* fail(`failed to trust tap ${tap}; a managed Homebrew that refuses trust must supply its entries through the external-homebrew contract`);
      }
    }
  }
});

const parsePlist = Effect.fn("parseExternalHomebrewPlist")(function*(path: string) {
  const converted = yield* runRaw("/usr/bin/plutil", ["-convert", "json", "-o", "-", path]);
  if (converted.status !== 0) return yield* fail(`invalid external Homebrew capability: ${path} is not a valid property list`);
  const json = yield* Effect.try({
    try: () => JSON.parse(converted.stdout) as unknown,
    catch: () => new CliFailure({ exitCode: 1, message: `invalid external Homebrew capability: ${path} is not a valid property list` }),
  });
  return yield* Schema.decodeUnknownEffect(ExternalHomebrew, { errors: "all", onExcessProperty: "error" })(json).pipe(
    Effect.mapError((error) => new CliFailure({ exitCode: 1, message: `invalid external Homebrew capability: ${error.message}` })),
  );
});

const declared = Effect.fn("externalHomebrewEntryDeclared")(function*(
  repoRoot: string,
  files: readonly string[],
  profile: string,
  packageType: "brew" | "cask",
  name: string,
) {
  const flag = packageType === "brew" ? "--formula" : "--cask";
  for (const file of files) {
    const listed = yield* runRaw("brew", ["bundle", "list", flag, "--file", join(repoRoot, file)], {
      env: { HOMEBREW_BUNDLE_DOTFILES_PROFILE: profile, HOMEBREW_NO_AUTO_UPDATE: "1" },
    });
    if (listed.status === 0 && listed.stdout.split("\n").includes(name)) return true;
  }
  return false;
});

const validateCommand = Effect.fn("validateExternalHomebrewCommand")(function*(
  packageType: string,
  name: string,
  path: string,
  args: readonly string[],
) {
  if (!isAbsolute(path)) return yield* fail(`invalid external Homebrew capability: ${packageType} ${name} command path must be absolute`);
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(path).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "File" || (info.value.mode & 0o111) === 0) {
    return yield* fail(`invalid external Homebrew capability: ${packageType} ${name} command is not executable: ${path}`);
  }
  const uid = Option.getOrUndefined(info.value.uid);
  if (uid !== process.getuid?.() && uid !== 0) return yield* fail(`invalid external Homebrew capability: ${path} must be owned by the current user or root`);
  if ((info.value.mode & 0o022) !== 0) return yield* fail(`invalid external Homebrew capability: ${path} must not be group or world writable`);
  const checked = yield* runRaw(path, args);
  if (checked.status !== 0) return yield* fail(`invalid external Homebrew capability: ${packageType} ${name} command check failed: ${path}`);
});

const validateBundle = Effect.fn("validateExternalHomebrewBundle")(function*(
  name: string,
  path: string,
  bundleIdentifier: string,
  teamIdentifier: string,
) {
  if (teamIdentifier === "not set") return yield* fail(`invalid external Homebrew capability: ${name} requires a concrete signing team`);
  if (!isAbsolute(path) || !path.endsWith(".app")) return yield* fail(`invalid external Homebrew capability: ${name} bundle path must be an absolute .app path`);
  const fs = yield* FileSystem.FileSystem;
  const link = yield* fs.readLink(path).pipe(Effect.option);
  const info = yield* fs.stat(path).pipe(Effect.option);
  if (Option.isSome(link) || Option.isNone(info) || info.value.type !== "Directory") {
    return yield* fail(`invalid external Homebrew capability: ${name} bundle is missing or symlinked: ${path}`);
  }
  const identifier = yield* runRaw("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", join(path, "Contents/Info.plist")]);
  if (identifier.status !== 0) return yield* fail(`invalid external Homebrew capability: ${name} bundle identifier is unreadable`);
  if (identifier.stdout.trim() !== bundleIdentifier) {
    return yield* fail(`invalid external Homebrew capability: ${name} bundle identifier is ${identifier.stdout.trim()}; expected ${bundleIdentifier}`);
  }
  const verified = yield* runRaw("/usr/bin/codesign", ["--verify", "--deep", "--strict", path]);
  if (verified.status !== 0) return yield* fail(`invalid external Homebrew capability: ${name} bundle signature verification failed`);
  const detail = yield* runRaw("/usr/bin/codesign", ["-dv", "--verbose=4", path]);
  const actualTeam = `${detail.stdout}\n${detail.stderr}`.split("\n").find((line) => line.startsWith("TeamIdentifier="))?.slice("TeamIdentifier=".length) || "";
  if (detail.status !== 0 || actualTeam !== teamIdentifier) {
    return yield* fail(`invalid external Homebrew capability: ${name} signing team is ${actualTeam || "missing"}; expected ${teamIdentifier}`);
  }
});

export const configureExternalCapabilities = Effect.fn("configureExternalHomebrewCapabilities")(function*(
  repoRoot: string,
  model: ProfileModel,
  profile: string,
) {
  const defaultPath = join(process.env.HOME || "", ".config/dotfiles/external-homebrew.plist");
  const path = process.env.DOTFILES_EXTERNAL_HOMEBREW_FILE || defaultPath;
  for (const key of ["HOMEBREW_BUNDLE_BREW_SKIP", "HOMEBREW_BUNDLE_CASK_SKIP", "HOMEBREW_BUNDLE_TAP_SKIP", "HOMEBREW_BUNDLE_MAS_SKIP"] as const) {
    if (process.env[key]) return yield* fail(`invalid external Homebrew capability: ambient Homebrew Bundle skip variables are unsupported; use ${path}`);
  }
  const fs = yield* FileSystem.FileSystem;
  const link = yield* fs.readLink(path).pipe(Effect.option);
  const exists = yield* fs.exists(path);
  if (!exists && Option.isNone(link)) return {};
  const info = yield* fs.stat(path).pipe(Effect.option);
  if (Option.isSome(link) || Option.isNone(info) || info.value.type !== "File") {
    return yield* fail(`invalid external Homebrew capability: ${path} must be a readable regular file`);
  }
  if (Option.getOrUndefined(info.value.uid) !== process.getuid?.()) return yield* fail(`invalid external Homebrew capability: ${path} must be owned by the current user`);
  if ((info.value.mode & 0o022) !== 0) return yield* fail(`invalid external Homebrew capability: ${path} must not be group or world writable`);
  yield* fs.access(path, { readable: true }).pipe(
    Effect.mapError(() => new CliFailure({ exitCode: 1, message: `invalid external Homebrew capability: ${path} must be a readable regular file` })),
  );
  const first = (yield* fs.readFileString(path)).split(/\r?\n/, 1)[0];
  if (!first?.startsWith("<?xml ")) return yield* fail(`invalid external Homebrew capability: ${path} must be an XML property list`);
  const config = yield* parsePlist(path);
  const seen = new Set<string>();
  const skips: Record<string, string[]> = { HOMEBREW_BUNDLE_BREW_SKIP: [], HOMEBREW_BUNDLE_CASK_SKIP: [] };
  for (const capability of config.capabilities) {
    if (!(yield* declared(repoRoot, profileBrewfiles(model, profile), profile, capability.packageType, capability.name))) {
      return yield* fail(`invalid external Homebrew capability: ${capability.packageType} ${capability.name} is not declared by profile ${profile}`);
    }
    const key = `${capability.packageType}|${capability.name}`;
    if (seen.has(key)) return yield* fail(`invalid external Homebrew capability: duplicate ${key}`);
    seen.add(key);
    if (capability.validator === "command") {
      if (capability.arguments.length > 3) return yield* fail(`invalid external Homebrew capability: ${capability.name} command validation accepts at most three arguments`);
      yield* validateCommand(capability.packageType, capability.name, capability.path, capability.arguments);
    } else {
      yield* validateBundle(capability.name, capability.path, capability.bundleIdentifier, capability.teamIdentifier);
    }
    skips[capability.packageType === "brew" ? "HOMEBREW_BUNDLE_BREW_SKIP" : "HOMEBREW_BUNDLE_CASK_SKIP"]?.push(capability.name);
    yield* Console.log(`validated external ${capability.packageType} ${capability.name}`);
  }
  return Object.fromEntries(Object.entries(skips).filter(([, values]) => values.length > 0).map(([key, values]) => [key, values.join(" ")]));
});

export { runRaw as runHomebrewRaw };
