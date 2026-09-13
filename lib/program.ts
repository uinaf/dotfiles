import { NodeRuntime } from "@effect/platform-node";
import { Effect, Schema } from "effect";

export class CliFailure extends Schema.TaggedError<CliFailure>()("CliFailure", {
  exitCode: Schema.Int,
  message: Schema.String,
}) {}

export const fail = (message: string, exitCode = 1): Effect.Effect<never, CliFailure> =>
  Effect.fail(new CliFailure({ exitCode, message }));

export function runMain(program: Effect.Effect<void, unknown>): void {
  program.pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        const failure = Schema.is(CliFailure)(error)
          ? error
          : new CliFailure({ exitCode: 1, message: error instanceof Error ? error.message : String(error) });
        process.stderr.write(`FAILED: ${failure.message}\n`);
        process.exitCode = failure.exitCode;
      }),
    ),
    NodeRuntime.runMain({ disableErrorReporting: true }),
  );
}
