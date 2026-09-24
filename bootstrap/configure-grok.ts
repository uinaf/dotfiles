#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { join, resolve } from "node:path";
import { configureGrokDefaults } from "../agents/grok/config.ts";
import { fail, runMain } from "../lib/program.ts";
import { profileModelFile, resolveProfile } from "../profiles/current.ts";
import { readProfileModelEffect, requireProfile } from "../profiles/model.ts";

if (import.meta.main) {
  const program = Effect.gen(function* () {
    const args = process.argv.slice(2);
    const profileIndex = args.indexOf("--profile");
    if (args.length > 2 || (args.length > 0 && (profileIndex !== 0 || !args[1])))
      return yield* fail("usage: configure-grok.ts [--profile PROFILE]", 2);
    const profile = yield* resolveProfile(profileIndex === 0 ? args[1] : undefined);
    requireProfile(yield* readProfileModelEffect(profileModelFile()), profile);
    const grokHome = resolve(process.env.GROK_HOME || join(process.env.HOME || "", ".grok"));
    const configPath = join(grokHome, "config.toml");
    const changed = yield* configureGrokDefaults(configPath);
    yield* Console.log(
      changed ? `configured Grok defaults in ${configPath}` : `ok Grok defaults in ${configPath}`,
    );
  });
  runMain(program.pipe(Effect.provide(NodeServices.layer)));
}
