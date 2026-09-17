#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { resolve } from "node:path";
import { configureHindsight, defaultPaths } from "../agents/hindsight.ts";
import { createRuntime } from "../agents/runtime.ts";
import { CommandRunner } from "../lib/command.ts";
import { fail, runMain } from "../lib/program.ts";

const program = Effect.gen(function* () {
  const args = process.argv.slice(2);
  const check = args.length === 1 && args[0] === "--check";
  if (args.length > (check ? 1 : 0))
    return yield* fail("usage: configure-hindsight.ts [--check]", 2);
  const home = resolve(process.env.HOME || "");
  const runtime = createRuntime();
  yield* configureHindsight(defaultPaths(home), (binary) => runtime.commandExists(binary), check);
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

if (import.meta.main) {
  runMain(program);
}
