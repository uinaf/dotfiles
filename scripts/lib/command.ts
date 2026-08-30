import { Context, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { CliFailure, fail } from "./program.ts";

export class CommandError extends Schema.TaggedError<CommandError>()("CommandError", {
  command: Schema.NonEmptyString,
  message: Schema.String,
}) {}

export type CommandResult = {
  readonly status: number;
  readonly stderr: string;
  readonly stdout: string;
};

export type CommandOptions = {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly extendEnv?: boolean;
  readonly stdin?: "ignore" | "inherit";
  readonly output?: "capture" | "inherit" | "ignore";
};

function decode(chunks: readonly Uint8Array[]): string {
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString();
}

export class CommandRunner extends Context.Service<CommandRunner, {
  readonly run: (
    command: string,
    args?: readonly string[],
    options?: CommandOptions,
  ) => Effect.Effect<CommandResult, CommandError>;
}>()("dotfiles/scripts/lib/CommandRunner") {
  static readonly layer = Layer.effect(
    CommandRunner,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const run = Effect.fn("CommandRunner.run")(function*(
        command: string,
        args: readonly string[] = [],
        options: CommandOptions = {},
      ) {
        const output = options.output ?? "capture";
        const execution = Effect.gen(function*() {
          const handle = yield* spawner.spawn(
            ChildProcess.make(command, args, {
              cwd: options.cwd,
              env: options.env,
              extendEnv: options.extendEnv ?? true,
              stdin: options.stdin ?? "ignore",
              stdout: output === "capture" ? "pipe" : output,
              stderr: output === "capture" ? "pipe" : output,
            }),
          );
          if (output !== "capture") {
            return { status: Number(yield* handle.exitCode), stderr: "", stdout: "" };
          }
          const stdoutFiber = yield* Stream.runCollect(handle.stdout).pipe(Effect.forkScoped);
          const stderrFiber = yield* Stream.runCollect(handle.stderr).pipe(Effect.forkScoped);
          const status = Number(yield* handle.exitCode);
          const [stdout, stderr] = yield* Effect.all([Fiber.join(stdoutFiber), Fiber.join(stderrFiber)]);
          return { status, stderr: decode(stderr), stdout: decode(stdout) };
        }).pipe(Effect.scoped);

        return yield* execution.pipe(
          Effect.mapError((error) => new CommandError({ command, message: String(error) })),
        );
      });

      return CommandRunner.of({ run });
    }),
  );
}

// Run a command, mapping a failed spawn (missing binary, bad cwd) to a CliFailure.
export const runCommand = Effect.fn("runCommand")(function*(
  command: string,
  args: readonly string[] = [],
  options: CommandOptions = {},
): Effect.fn.Return<CommandResult, CliFailure, CommandRunner> {
  const runner = yield* CommandRunner;
  return yield* runner.run(command, args, options).pipe(
    Effect.mapError((error) =>
      new CliFailure({ exitCode: 1, message: `${command} is required or failed to start: ${error.message}` })
    ),
  );
});

// Run a command and propagate a non-zero exit status as the process exit code.
export const runChecked = Effect.fn("runChecked")(function*(
  command: string,
  args: readonly string[] = [],
  options: CommandOptions = {},
): Effect.fn.Return<CommandResult, CliFailure, CommandRunner> {
  const result = yield* runCommand(command, args, options);
  if (result.status !== 0) {
    return yield* fail(`${command} exited ${result.status}`, result.status);
  }
  return result;
});
