import { Console, Effect } from "effect";
import { CommandRunner } from "../../lib/command.ts";
import { CliFailure, fail } from "../../lib/program.ts";

// The weekly devbox disk-cleanup LaunchAgent was retired in favor of the
// six-hour updater's host hygiene step. Its plist is listed in .chezmoiremove;
// launchd keeps a booted-out-of-disk job loaded until logout, so unload it
// explicitly before chezmoi removes the file. Idempotent: not-loaded is a no-op.
export const retiredAgentLabels = ["local.dotfiles.disk-cleanup"] as const;

export const retireLaunchAgents = Effect.fn("retireLaunchAgents")(function* (
  uid: number,
  dryRun: boolean,
  platform: NodeJS.Platform = process.platform,
) {
  if (platform !== "darwin" || uid <= 0) return;
  const runner = yield* CommandRunner;
  for (const label of retiredAgentLabels) {
    const service = `gui/${uid}/${label}`;
    const loaded = yield* runner.run("launchctl", ["print", service]).pipe(
      Effect.map((result) => result.status === 0),
      Effect.catch(() => Effect.succeed(false)),
    );
    if (!loaded) continue;
    if (dryRun) {
      yield* Console.log(`would boot out retired LaunchAgent ${service}`);
      continue;
    }
    const result = yield* runner
      .run("launchctl", ["bootout", service])
      .pipe(Effect.mapError((error) => new CliFailure({ exitCode: 1, message: error.message })));
    if (result.status !== 0)
      return yield* fail(`launchctl bootout ${service} exited ${result.status}`, result.status);
    yield* Console.log(`booted out retired LaunchAgent ${service}`);
  }
});
