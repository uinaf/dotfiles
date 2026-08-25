import { Context, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

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
