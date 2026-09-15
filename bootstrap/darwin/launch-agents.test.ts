import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { Effect } from "effect";
import { CommandRunner } from "../../lib/command.ts";
import { CliFailure } from "../../lib/program.ts";
import { retireLaunchAgents, retiredAgentLabels } from "./launch-agents.ts";

function launchctlRunner(loaded: boolean, bootoutStatus = 0) {
  const calls: string[][] = [];
  const runner = CommandRunner.of({
    run: (command, args = []) => {
      calls.push([command, ...args]);
      const status = args[0] === "print" ? (loaded ? 0 : 113) : bootoutStatus;
      return Effect.succeed({ status, stdout: "", stderr: "" });
    },
  });
  return { calls, runner };
}

test("a loaded retired LaunchAgent is booted out exactly once", async () => {
  const { calls, runner } = launchctlRunner(true);
  await Effect.runPromise(
    retireLaunchAgents(501, false, "darwin").pipe(Effect.provideService(CommandRunner, runner)),
  );
  assert.deepEqual(
    calls,
    retiredAgentLabels.flatMap((label) => [
      ["launchctl", "print", `gui/501/${label}`],
      ["launchctl", "bootout", `gui/501/${label}`],
    ]),
  );
});

test("a retired LaunchAgent that is not loaded is left alone", async () => {
  const { calls, runner } = launchctlRunner(false);
  await Effect.runPromise(
    retireLaunchAgents(501, false, "darwin").pipe(Effect.provideService(CommandRunner, runner)),
  );
  assert.deepEqual(
    calls,
    retiredAgentLabels.map((label) => ["launchctl", "print", `gui/501/${label}`]),
  );
});

test("dry runs and non-macOS hosts never boot out anything", async () => {
  const dry = launchctlRunner(true);
  await Effect.runPromise(
    retireLaunchAgents(501, true, "darwin").pipe(Effect.provideService(CommandRunner, dry.runner)),
  );
  assert.ok(dry.calls.every((call) => call[1] === "print"));
  const linux = launchctlRunner(true);
  await Effect.runPromise(
    retireLaunchAgents(501, false, "linux").pipe(
      Effect.provideService(CommandRunner, linux.runner),
    ),
  );
  assert.deepEqual(linux.calls, []);
});

test("a failed bootout surfaces its launchctl status", async () => {
  const { runner } = launchctlRunner(true, 5);
  const failure = await Effect.runPromise(
    retireLaunchAgents(501, false, "darwin").pipe(
      Effect.provideService(CommandRunner, runner),
      Effect.flip,
    ),
  );
  assert.ok(failure instanceof CliFailure);
  assert.equal(failure.exitCode, 5);
});
