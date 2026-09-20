#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option, Schema } from "effect";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../lib/command.ts";
import { fail, runMain } from "../lib/program.ts";
import { BoundedCommand } from "./bounded-command.ts";
import { dailyLog, rotateUpdateLog } from "./logs.ts";

const Job = Schema.Literal("software-update");
type Job = typeof Job.Type;
const Config = Schema.Record(Schema.String, Schema.String);
const PreviousReceipt = Schema.Struct({ cleanupComplete: Schema.optionalKey(Schema.Boolean) });
type Delivery = "not-configured" | "sent" | "failed";

class HeartbeatFailure extends Schema.TaggedError<HeartbeatFailure>()("HeartbeatFailure", {
  retryable: Schema.Boolean,
  cause: Schema.Defect(),
}) {}

export const runUpdate = Effect.fn("runMonitoredUpdate")(function* (
  job: Job,
  home: string,
  command: string,
  args: readonly string[],
  send: typeof fetch = fetch,
  retryWait: Effect.Effect<void> = Effect.sleep("10 seconds"),
) {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* BoundedCommand;
  const startedAt = new Date().toISOString();
  const directory = join(home, ".local/state/dotfiles/updates");
  const path = join(directory, `${job}.json`);
  const configPath = join(home, ".config/dotfiles/update-heartbeats.json");
  let delivery: Delivery = "not-configured";
  yield* Effect.try(() => rotateUpdateLog(home, job)).pipe(
    Effect.catch(() => Console.error("Could not rotate update logs; updates will continue.")),
  );
  const receipt = Effect.fn("writeUpdateReceipt")(
    function* (fields: Record<string, unknown>) {
      const record = `${JSON.stringify({ version: 1, job, startedAt, ...fields })}\n`;
      yield* Console.log(`Update receipt: ${record.trim()}`);
      yield* Effect.gen(function* () {
        const history = yield* Effect.try(() => dailyLog(home, `${job}-history`));
        yield* fs.writeFileString(history, record, { flag: "a", mode: 0o600 });
      }).pipe(
        Effect.catch(() =>
          Console.error("Could not append update history; inspect the update log."),
        ),
      );
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      const temporary = `${path}.${process.pid}.tmp`;
      yield* fs.writeFileString(temporary, record, { mode: 0o600 });
      yield* fs.rename(temporary, path);
      return true;
    },
    Effect.catch(() =>
      Console.error("Could not write update receipt; inspect launchd and the update log.").pipe(
        Effect.as(false),
      ),
    ),
  );

  const destination = yield* Effect.gen(function* () {
    if (!(yield* fs.exists(configPath))) return undefined;
    const link = yield* fs.readLink(configPath).pipe(Effect.option);
    const info = yield* fs.stat(configPath);
    if (
      Option.isSome(link) ||
      info.type !== "File" ||
      Option.getOrUndefined(info.uid) !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    ) {
      return yield* fail("heartbeat config must be an owner-only regular file");
    }
    const config = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Config))(
      yield* fs.readFileString(configPath),
    );
    const value = config[job];
    if (!value) return undefined;
    const url = yield* Effect.try(() => new URL(value));
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      return yield* fail(
        "heartbeat destinations must be HTTPS URLs without credentials, queries, or fragments",
      );
    }
    return url.href.replace(/\/$/, "");
  }).pipe(
    Effect.catch(() =>
      Effect.gen(function* () {
        delivery = "failed";
        yield* Console.error(
          "Invalid update heartbeat configuration; updates will continue without delivery.",
        );
        return undefined;
      }),
    ),
  );

  const blocked = yield* Effect.gen(function* () {
    if (!(yield* fs.exists(path))) return false;
    const previous = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PreviousReceipt))(
      yield* fs.readFileString(path),
    );
    return previous.cleanupComplete === false;
  }).pipe(Effect.catch(() => Effect.succeed(true)));
  if (blocked)
    yield* Console.error(
      "Previous update cleanup is unverified; refusing to start another update.",
    );
  const gateSaved = yield* receipt({ state: "running", cleanupComplete: false });
  if (!gateSaved)
    yield* Console.error("Cannot persist the cleanup gate; refusing to start another update.");
  const execution =
    blocked || !gateSaved
      ? { status: 125, timedOut: false, cleanupComplete: !blocked }
      : yield* runner
          .run(command, args, {
            diagnosticDirectory: join(directory, "diagnostics"),
          })
          .pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                yield* Console.error("Update command failed to execute.");
                return { status: 127, timedOut: false, cleanupComplete: error.cleanupComplete };
              }),
            ),
          );
  const status = execution.cleanupComplete ? execution.status : execution.status || 1;
  if (execution.timedOut) {
    yield* Console.error("Update exceeded its execution deadline; reporting failure.");
    yield* Console.error(
      "diagnosticPath" in execution && execution.diagnosticPath
        ? `Timeout diagnostics: ${execution.diagnosticPath}`
        : "Timeout diagnostics could not be saved.",
    );
  }
  if (!execution.cleanupComplete)
    yield* Console.error("Update process cleanup is incomplete; inspect before retrying.");
  // Persist cleanup before network delivery: cancellation must not reopen the retry gate.
  yield* receipt({
    state: "running",
    exitCode: status,
    cleanupComplete: execution.cleanupComplete,
    ...(execution.timedOut ? { timedOut: true } : {}),
  });
  if (destination) {
    const deliver = Effect.tryPromise({
      try: async (signal) => {
        const response = await send(`${destination}${status === 0 ? "" : "/fail"}`, {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        });
        await response.body?.cancel();
        if (!response.ok)
          throw new HeartbeatFailure({
            retryable: response.status === 408 || response.status === 429 || response.status >= 500,
            cause: new Error(`heartbeat rejected with HTTP ${response.status}`),
          });
        return "sent" as const;
      },
      catch: (cause) =>
        Schema.is(HeartbeatFailure)(cause)
          ? cause
          : new HeartbeatFailure({ retryable: true, cause }),
    });
    delivery = yield* deliver.pipe(
      // One bounded retry: a transient blip must not page as a missed heartbeat.
      // The update result is already final, so retrying repeats no package work.
      Effect.catch((error) =>
        error.retryable ? retryWait.pipe(Effect.flatMap(() => deliver)) : Effect.fail(error),
      ),
      Effect.catch(() =>
        Effect.gen(function* () {
          yield* Console.error(
            "Update heartbeat delivery failed; the update will not be repeated.",
          );
          return "failed" as const;
        }),
      ),
    );
  }
  yield* receipt({
    state: "finished",
    finishedAt: new Date().toISOString(),
    exitCode: status,
    heartbeat: delivery,
    ...(execution.timedOut ? { timedOut: true } : {}),
    ...(execution.timedOut || !execution.cleanupComplete
      ? { cleanupComplete: execution.cleanupComplete }
      : {}),
  });
  return status;
});

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const program = Effect.gen(function* () {
    const [job, separator, command, ...args] = process.argv.slice(2);
    if (!Schema.is(Job)(job) || separator !== "--" || !command || !process.env.HOME) {
      return yield* fail("Usage: run.ts <software-update> -- COMMAND [ARGS...]", 2);
    }
    process.exitCode = yield* runUpdate(job, process.env.HOME, command, args);
  }).pipe(
    Effect.provide(BoundedCommand.layer),
    Effect.provide(CommandRunner.layer),
    Effect.provide(NodeServices.layer),
  );
  runMain(program);
}
