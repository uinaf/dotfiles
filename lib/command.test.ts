import assert from "node:assert/strict";
import { NodeServices } from "@effect/platform-node";
import { Cause, Effect, Exit, PlatformError } from "effect";
import { test } from "vite-plus/test";
import { CommandError, CommandRunner } from "./command.ts";

test("a missing executable retains its structured platform cause", async () => {
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const runner = yield* CommandRunner;
      return yield* runner.run("/dotfiles-test-missing-executable");
    }).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer)),
  );
  assert.ok(Exit.isFailure(exit));
  const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
  assert.ok(error instanceof CommandError);
  assert.ok(error.cause instanceof PlatformError.PlatformError);
  assert.equal(error.cause.reason._tag, "NotFound");
  assert.equal(error.message, String(error.cause));
});
