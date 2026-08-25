#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Effect, Option } from "effect";
import { CommandRunner } from "../lib/command.ts";
import { fail, runMain } from "../lib/program.ts";
import {
  commandAvailable,
  repairSharedReadability,
  requirePrefixOwner,
  runHomebrewRaw,
  verifyPrefixPermissions,
} from "../lib/homebrew.ts";

const program = Effect.gen(function*() {
  if (!(yield* commandAvailable("brew"))) return yield* fail("brew is required before running this script");
  yield* requirePrefixOwner();
  const args = process.argv.slice(2);
  if (args[0] === "--repair-shared-readability") {
    if (args.length !== 1) return yield* fail("Usage: scripts/bootstrap/brew-devbox.ts --repair-shared-readability", 2);
    yield* repairSharedReadability();
    yield* verifyPrefixPermissions();
    return;
  }
  yield* verifyPrefixPermissions();
  const previousUmask = yield* Effect.sync(() => process.umask(0o027));
  const brewed = yield* runHomebrewRaw("brew", args, { output: "inherit" }).pipe(
    Effect.ensuring(Effect.sync(() => { process.umask(previousUmask); })),
  );
  const repaired = yield* repairSharedReadability().pipe(
    Effect.andThen(verifyPrefixPermissions()),
    Effect.option,
  );
  if (brewed.status !== 0) return yield* fail(`brew exited ${brewed.status}`, brewed.status);
  if (Option.isNone(repaired)) return yield* fail("Homebrew shared readability repair failed");
}).pipe(
  Effect.provide(CommandRunner.layer),
  Effect.provide(NodeServices.layer),
);

runMain(program);
