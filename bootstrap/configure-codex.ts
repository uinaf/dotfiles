#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { configureDefaults } from "../agents/codex/config.ts";
import { runMain } from "../lib/program.ts";
import { profileModelFile, resolveProfile } from "../profiles/current.ts";
import { readProfileModelEffect, requireProfile } from "../profiles/model.ts";

if (import.meta.main) {
  const program = Effect.gen(function* () {
    const args = process.argv.slice(2);
    const profileIndex = args.indexOf("--profile");
    if (args.length > 2 || (args.length > 0 && (profileIndex !== 0 || !args[1]))) {
      return yield* Effect.fail(new Error("usage: configure-codex.ts [--profile PROFILE]"));
    }
    const profile = yield* resolveProfile(profileIndex === 0 ? args[1] : undefined);
    const model = yield* readProfileModelEffect(profileModelFile());
    requireProfile(model, profile);
    const configPath = yield* Effect.tryPromise({
      try: () => configureDefaults(),
      catch: (error) => error,
    });
    yield* Console.log(`configured Codex defaults in ${configPath}`);
  });
  runMain(program.pipe(Effect.provide(NodeServices.layer)));
}
