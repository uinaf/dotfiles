import { NodeSink, NodeStream } from "@effect/platform-node";
import { Cause, Effect, Queue, Schema, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { GatewayFailure, failure, main } from "./gateway-runtime.ts";

const Authenticate = Schema.Struct({ method: Schema.Literal("authenticate"), id: Schema.Unknown });
class ChildInputFailure extends Schema.TaggedError<ChildInputFailure>()("ChildInputFailure", {
  cause: Schema.Defect(),
}) {}
const program = Effect.scoped(Effect.gen(function*() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) return yield* failure("usage: cursor-acp-api-key-auth <cursor-agent> [args...]", 2);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make(command, args, {
    stdin: "pipe", stdout: "pipe", stderr: "inherit", forceKillAfter: "5 seconds",
  }));
  const replies = yield* Queue.bounded<string, Cause.Done>(16);
  const input = NodeStream.fromReadable({ evaluate: () => process.stdin }).pipe(
    Stream.decodeText(), Stream.splitLines,
    Stream.mapEffect(Effect.fn("filterCursorAuthentication")(function*(line) {
      const message = yield* Effect.try(() => JSON.parse(line) as unknown).pipe(Effect.orElseSucceed(() => undefined));
      if (Schema.is(Authenticate)(message)) {
        yield* Queue.offer(replies, `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`);
        return "";
      }
      return `${line}\n`;
    })),
    Stream.encodeText,
    Stream.run(child.stdin.pipe(Sink.mapError((cause) => new ChildInputFailure({ cause })))),
    // Closed child input does not invalidate its remaining output or exit status.
    Effect.catchTag("ChildInputFailure", () => Effect.never),
    // EOF closes child stdin; the child still owns its remaining output/status.
    Effect.andThen(Effect.never),
  );
  const output = child.stdout.pipe(
    Stream.decodeText(), Stream.splitLines,
    Stream.runForEach((line) => Queue.offer(replies, `${line}\n`)),
  );
  const finish = Effect.all([output, child.exitCode], { concurrency: "unbounded" }).pipe(
    Effect.map(([, status]) => { process.exitCode = status; }),
  );
  const writer = Stream.fromQueue(replies).pipe(Stream.run(NodeSink.fromWritable({
    evaluate: () => process.stdout, endOnDone: false,
    onError: () => new GatewayFailure({ message: "Cursor ACP output closed" }),
  })));
  // Child exit cancels an upstream reader whose client has not closed stdin.
  // Both producers share one bounded sink so replies cannot split child lines.
  yield* Effect.all([
    Effect.raceFirst(input, finish).pipe(Effect.ensuring(Queue.end(replies))), writer,
  ], { concurrency: "unbounded" });
}));

main(program);
