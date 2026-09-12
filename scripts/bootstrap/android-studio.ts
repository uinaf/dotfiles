#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Schema } from "effect";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../lib/command.ts";
import { requirePrefixOwner } from "../lib/homebrew.ts";
import { CliFailure, fail, runMain } from "../lib/program.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultPinPath = join(repoRoot, "chezmoi/.chezmoidata/android-studio.json");
const caskToken = "android-studio";
const usage = `Usage:
  scripts/bootstrap/android-studio.ts
  scripts/bootstrap/android-studio.ts --check

Installs the declared Android Studio release with the stable Homebrew cask.
--check reports the installed cask version only. Unattended software updates
do not run this. Preview and beta casks do not count.`;

const AndroidStudioPin = Schema.Struct({
  version: Schema.Literal(1),
  release: Schema.NonEmptyString,
});

export type AndroidStudioPin = typeof AndroidStudioPin.Type;

export type AndroidStudioCask = {
  token: string;
  version: string;
  installed?: string;
};

const previewLabel = /beta|canary|rc|preview|nightly/i;
const stableRelease = /^\d+\.\d+\.\d+\.\d+$/;

export function normalizeRelease(version: string): string {
  return version.split(",")[0]?.trim() ?? "";
}

export function satisfiesPin(version: string, pin: string): boolean {
  if (previewLabel.test(version)) return false;
  const release = normalizeRelease(version);
  return stableRelease.test(release) && release === pin;
}

export function parseCaskInfo(contents: string): AndroidStudioCask | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  const cask = (parsed as { casks?: unknown[] }).casks?.[0];
  if (!cask || typeof cask !== "object") return undefined;
  const token = (cask as { token?: unknown }).token;
  const version = (cask as { version?: unknown }).version;
  const installed = (cask as { installed?: unknown }).installed;
  if (token !== caskToken || typeof version !== "string" || version.length === 0) return undefined;
  return {
    token,
    version,
    ...(typeof installed === "string" && installed.length > 0 ? { installed } : {}),
  };
}

export function pickInstallTarget(cask: AndroidStudioCask | undefined, pin: string): AndroidStudioCask | undefined {
  if (!cask || cask.token !== caskToken) return undefined;
  return satisfiesPin(cask.version, pin) ? cask : undefined;
}

export function describeRelease(version: string): string {
  return normalizeRelease(version);
}

const brewEnv = { HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_UPGRADE_QUIT_CASKS: "1" };

const readPin = Effect.fn("readAndroidStudioPin")(function*() {
  const fs = yield* FileSystem.FileSystem;
  const path = process.env.DOTFILES_ANDROID_STUDIO_FILE || defaultPinPath;
  const contents = yield* fs.readFileString(path).pipe(
    Effect.mapError((error) => new CliFailure({ exitCode: 1, message: `cannot read Android Studio pin ${path}: ${error}` })),
  );
  const parsed = yield* Effect.try({
    try: () => JSON.parse(contents) as unknown,
    catch: (error) => new CliFailure({
      exitCode: 1,
      message: `Android Studio pin ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    }),
  });
  return yield* Schema.decodeUnknownEffect(AndroidStudioPin)(parsed).pipe(
    Effect.mapError((error) => new CliFailure({ exitCode: 1, message: `Android Studio pin ${path} is invalid: ${error.message}` })),
  );
});

const caskInfo = Effect.fn("androidStudioCaskInfo")(function*() {
  const runner = yield* CommandRunner;
  const result = yield* runner.run("brew", ["info", "--json=v2", "--cask", caskToken], { env: brewEnv });
  if (result.status !== 0) {
    return yield* fail(`brew info --cask ${caskToken} exited ${result.status}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`, result.status);
  }
  const cask = parseCaskInfo(result.stdout);
  if (!cask) return yield* fail(`brew did not report the stable ${caskToken} cask`);
  return cask;
});

const checkPin = Effect.fn("checkAndroidStudioPin")(function*(pin: AndroidStudioPin) {
  const cask = yield* caskInfo();
  if (!cask.installed) return yield* fail("Android Studio is not installed; install the declared release with mise run android-studio:install");
  if (!satisfiesPin(cask.installed, pin.release)) {
    return yield* fail(`installed Android Studio is ${describeRelease(cask.installed)}; pin is ${pin.release}`);
  }
  yield* Console.log(`Android Studio ${describeRelease(cask.installed)} matches pin ${pin.release}`);
});

const installRelease = Effect.fn("installAndroidStudioRelease")(function*(pin: AndroidStudioPin) {
  yield* requirePrefixOwner();
  const cask = yield* caskInfo();
  if (cask.installed && satisfiesPin(cask.installed, pin.release)) {
    yield* Console.log(`Android Studio ${describeRelease(cask.installed)} already installed`);
    return;
  }
  const target = pickInstallTarget(cask, pin.release);
  if (!target) {
    return yield* fail(`no stable Android Studio ${pin.release} is available from brew; brew has ${describeRelease(cask.version)}`);
  }
  const runner = yield* CommandRunner;
  const args = cask.installed
    ? ["upgrade", "--cask", "--greedy", caskToken]
    : ["install", "--cask", caskToken];
  yield* Console.log(`${cask.installed ? "Upgrading" : "Installing"} Android Studio ${describeRelease(target.version)}`);
  const result = yield* runner.run("brew", args, { env: brewEnv, output: "inherit" });
  if (result.status !== 0) return yield* fail(`brew ${args[0]} --cask ${caskToken} exited ${result.status}`, result.status);
});

const program = Effect.gen(function*() {
  const args = process.argv.slice(2);
  let check = false;
  for (const argument of args) {
    if (argument === "--check") check = true;
    else if (argument === "-h" || argument === "--help") {
      yield* Console.log(usage);
      return;
    } else {
      yield* Console.error(usage);
      return yield* fail(`unsupported argument ${argument}`, 2);
    }
  }
  const pin = yield* readPin();
  if (check) return yield* checkPin(pin);
  yield* installRelease(pin);
  yield* checkPin(pin);
}).pipe(
  Effect.provide(CommandRunner.layer),
  Effect.provide(NodeServices.layer),
);

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runMain(program);
}
