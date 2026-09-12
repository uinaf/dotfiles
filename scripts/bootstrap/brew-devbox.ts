#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Effect, Option } from "effect";
import { resolve } from "node:path";
import { acquireCheckoutLock } from "../maintenance/converge.ts";
import { CommandRunner } from "../lib/command.ts";
import { fail, runMain } from "../lib/program.ts";
import {
  commandAvailable,
  repairSharedReadability,
  requirePrefixOwner,
  runHomebrewRaw,
  verifyPrefixPermissions,
} from "../lib/homebrew.ts";

const greedySkipCasks = new Set(["android-studio"]);

const program = Effect.gen(function*() {
  if (!(yield* commandAvailable("brew"))) return yield* fail("brew is required before running this script");
  yield* requirePrefixOwner();
  const args = process.argv.slice(2);
  const updateSoftware = args[0] === "--update-software";
  if (updateSoftware && args.length !== 1) return yield* fail("Usage: scripts/bootstrap/brew-devbox.ts --update-software", 2);
  if (updateSoftware) yield* Effect.acquireRelease(
    Effect.try(() => acquireCheckoutLock(resolve(import.meta.dirname, "../.."))),
    (release) => Effect.sync(release),
  );
  if (args[0] === "--repair-shared-readability") {
    if (args.length !== 1) return yield* fail("Usage: scripts/bootstrap/brew-devbox.ts --repair-shared-readability", 2);
    yield* repairSharedReadability();
    yield* verifyPrefixPermissions();
    return;
  }
  yield* verifyPrefixPermissions();
  const runBrew = Effect.fn("runBrewDevboxCommand")(function*(command: readonly string[]) {
    const previousUmask = yield* Effect.sync(() => process.umask(0o027));
    const brewed = yield* runHomebrewRaw("brew", command, { output: "inherit" }).pipe(
      Effect.ensuring(Effect.sync(() => { process.umask(previousUmask); })),
    );
    const repaired = yield* repairSharedReadability().pipe(
      Effect.andThen(verifyPrefixPermissions()),
      Effect.option,
    );
    if (brewed.status !== 0) return yield* fail(`brew exited ${brewed.status}`, brewed.status);
    if (Option.isNone(repaired)) return yield* fail("Homebrew shared readability repair failed");
  });
  if (!updateSoftware) {
    yield* runBrew(args);
    return;
  }
  yield* runBrew(["developer", "off"]);
  yield* runBrew(["update"]);
  yield* runBrew(["upgrade", "--greedy", "--no-ask", "--formula"]);
  const listed = yield* runHomebrewRaw("brew", ["list", "--cask", "--full-name"]);
  if (listed.status !== 0) return yield* fail(`brew list --cask exited ${listed.status}`, listed.status);
  const casks = listed.stdout.split("\n").map((line) => line.trim()).filter((name) => name && !greedySkipCasks.has(name));
  if (casks.length > 0) yield* runBrew(["upgrade", "--greedy", "--no-ask", "--cask", ...casks]);
}).pipe(
  Effect.scoped,
  Effect.provide(CommandRunner.layer),
  Effect.provide(NodeServices.layer),
);

runMain(program);
