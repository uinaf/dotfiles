import assert from "node:assert/strict";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { test } from "vite-plus/test";
import { CommandError, CommandRunner } from "../../lib/command.ts";
import { checkDevboxPhotoAnalysis } from "./photo-analysis.ts";

for (const profile of [
  "developer",
  "workstation",
  "personal-workstation",
  "devbox",
  "personal-devbox",
]) {
  for (const platform of ["darwin", "linux"] as const) {
    test(`Photos verification boundary: ${profile} on ${platform}`, async () => {
      const calls: string[][] = [];
      const runner = CommandRunner.of({
        run: (command, args = []) => {
          calls.push([command, ...args]);
          return Effect.succeed({
            status: 0,
            stdout: '"com.apple.photoanalysisd" => disabled',
            stderr: "",
          });
        },
      });
      await Effect.runPromise(
        checkDevboxPhotoAnalysis(profile, 501, platform).pipe(
          Effect.provideService(CommandRunner, runner),
          Effect.provide(NodeServices.layer),
        ),
      );
      assert.deepEqual(
        calls,
        platform === "darwin" && profile.endsWith("devbox")
          ? [["launchctl", "print-disabled", "gui/501"]]
          : [],
      );
    });
  }
}
for (const output of [
  '"com.apple.photoanalysisd" => enabled',
  '"com.apple.photoanalysisd" => false',
  "",
  '"com.apple.photoanalysisd.other" => disabled',
]) {
  test(`Photos verification rejects drift: ${output}`, async () => {
    const runner = CommandRunner.of({
      run: () => Effect.succeed({ status: 0, stdout: output, stderr: "" }),
    });
    await assert.rejects(
      Effect.runPromise(
        checkDevboxPhotoAnalysis("devbox", 501, "darwin").pipe(
          Effect.provideService(CommandRunner, runner),
          Effect.provide(NodeServices.layer),
        ),
      ),
      /policy drift/,
    );
  });
}
for (const failure of ["exit", "spawn"] as const) {
  test(`Photos verification fails closed on ${failure}`, async () => {
    const runner = CommandRunner.of({
      run: () =>
        failure === "spawn"
          ? Effect.fail(new CommandError({ command: "launchctl", message: "unavailable" }))
          : Effect.succeed({
              status: 1,
              stdout: '"com.apple.photoanalysisd" => disabled',
              stderr: "",
            }),
    });
    await assert.rejects(
      Effect.runPromise(
        checkDevboxPhotoAnalysis("devbox", 501, "darwin").pipe(
          Effect.provideService(CommandRunner, runner),
          Effect.provide(NodeServices.layer),
        ),
      ),
    );
  });
}
test("Photos verification rejects root without invoking launchctl", async () => {
  const runner = CommandRunner.of({
    run: () => {
      throw new Error("must not run");
    },
  });
  await assert.rejects(
    Effect.runPromise(
      checkDevboxPhotoAnalysis("devbox", 0, "darwin").pipe(
        Effect.provideService(CommandRunner, runner),
        Effect.provide(NodeServices.layer),
      ),
    ),
    /non-root/,
  );
});
