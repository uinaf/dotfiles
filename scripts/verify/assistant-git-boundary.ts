#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { resolve } from "node:path";
import { CommandRunner } from "../lib/command.ts";
import { CliFailure, fail, runMain } from "../lib/program.ts";

const program = Effect.gen(function*() {
  const runner = yield* CommandRunner;
  const owner = resolve(import.meta.dirname, "workload-git-boundary.ts");
  const result = yield* runner.run(owner, ["--profile", "assistant"], { stdin: "inherit", output: "inherit" }).pipe(
    Effect.mapError((error) => new CliFailure({ exitCode: 1, message: error.message })),
  );
  if (result.status !== 0) return yield* fail(`${owner} exited ${result.status}`, result.status);
}).pipe(
  Effect.provide(CommandRunner.layer),
  Effect.provide(NodeServices.layer),
);

runMain(program);
