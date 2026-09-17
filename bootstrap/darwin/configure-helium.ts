#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Schema } from "effect";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../../lib/command.ts";
import { fail, runMain } from "../../lib/program.ts";

const decodeObject = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown));
const decodeStrings = Schema.decodeUnknownEffect(Schema.Array(Schema.String));

// Helium's canvas and audio noise trip Stytch device-fingerprint verdicts, which
// breaks magic-link sign-in; "@2" is Chromium's disabled state for a flag entry.
export const disabledFlags = ["helium-noise-canvas@2", "helium-noise-audio@2"];

export const configureHelium = Effect.fn("configureHelium")(function* (
  root: string,
  skipRunning = false,
) {
  const runner = yield* CommandRunner;
  const fs = yield* FileSystem.FileSystem;
  if (!process.getuid) return yield* fail("Helium setup requires a Unix user");
  const running = yield* runner.run("pgrep", ["-u", String(process.getuid()), "-x", "Helium"]);
  if (running.status === 0) {
    const message =
      "Quit Helium and rerun bootstrap/darwin/configure-helium.ts to apply vertical tabs and flags.";
    if (!skipRunning) return yield* fail(message);
    yield* Console.log(`Deferred Helium preferences: ${message}`);
    return;
  }
  if (running.status !== 1) return yield* fail("Could not check whether Helium is running");

  const profiles: string[] = [];
  if (yield* fs.exists(root)) {
    for (const name of yield* fs.readDirectory(root)) {
      if (name === "System Profile" || name === "Guest Profile") continue;
      const directory = join(root, name);
      if ((yield* fs.stat(directory)).type !== "Directory") continue;
      const path = join(directory, "Preferences");
      if (yield* fs.exists(path)) profiles.push(path);
    }
  }
  if (profiles.length === 0) profiles.push(join(root, "Default", "Preferences"));

  const updates = [];
  for (const path of profiles.sort()) {
    const exists = yield* fs.exists(path);
    const source = exists ? yield* fs.readFileString(path) : "{}";
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(source),
      catch: () => new Error(`Invalid JSON in ${path}`),
    });
    const data = yield* decodeObject(parsed);
    const helium = yield* decodeObject(data.helium === undefined ? {} : data.helium);
    const browser = yield* decodeObject(helium.browser === undefined ? {} : helium.browser);
    if (browser.layout === 2) continue;
    // HeliumLayoutType::kVertical is a profile preference, not a Chromium flag.
    const contents = JSON.stringify({
      ...data,
      helium: { ...helium, browser: { ...browser, layout: 2 } },
    });
    const mode = exists ? (yield* fs.stat(path)).mode & 0o777 : 0o600;
    updates.push({ path, contents, mode });
  }

  const statePath = join(root, "Local State");
  const stateExists = yield* fs.exists(statePath);
  const stateSource = stateExists ? yield* fs.readFileString(statePath) : "{}";
  const stateParsed = yield* Effect.try({
    try: (): unknown => JSON.parse(stateSource),
    catch: () => new Error(`Invalid JSON in ${statePath}`),
  });
  const state = yield* decodeObject(stateParsed);
  const stateBrowser = yield* decodeObject(state.browser === undefined ? {} : state.browser);
  const flags = yield* decodeStrings(
    stateBrowser.enabled_labs_experiments === undefined
      ? []
      : stateBrowser.enabled_labs_experiments,
  );
  const flagNames = new Set(disabledFlags.map((flag) => flag.split("@")[0]));
  const missing = disabledFlags.filter((flag) => !flags.includes(flag));
  if (missing.length > 0) {
    // Drop any other state of the same flag so the disabled entry wins.
    const kept = flags.filter((flag) => !flagNames.has(flag.split("@")[0] ?? flag));
    const contents = JSON.stringify({
      ...state,
      browser: { ...stateBrowser, enabled_labs_experiments: [...kept, ...disabledFlags] },
    });
    const mode = stateExists ? (yield* fs.stat(statePath)).mode & 0o777 : 0o600;
    updates.push({ path: statePath, contents, mode });
  }

  for (const { path, contents, mode } of updates) {
    const directory = dirname(path);
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const temporary = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".helium." });
        const staged = join(temporary, "staged");
        yield* fs.writeFileString(staged, `${contents}\n`, { mode });
        yield* fs.chmod(staged, mode);
        yield* fs.rename(staged, path);
      }),
    );
  }
  yield* Console.log(
    `Helium: ${updates.length} files updated, ${profiles.length} profiles checked, ${missing.length} flags pinned.`,
  );
});

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  runMain(
    Effect.gen(function* () {
      const args = process.argv.slice(2);
      if (args.length > 1 || (args.length === 1 && args[0] !== "--skip-running"))
        return yield* fail("Usage: bootstrap/darwin/configure-helium.ts [--skip-running]", 2);
      if (process.platform !== "darwin") return yield* fail("Helium setup requires macOS", 2);
      yield* configureHelium(
        join(process.env.HOME || "", "Library/Application Support/net.imput.helium"),
        args[0] === "--skip-running",
      );
    }).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer)),
  );
}
