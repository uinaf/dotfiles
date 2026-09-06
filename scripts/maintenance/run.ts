#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option, Schema } from "effect";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../lib/command.ts";
import { fail, runMain } from "../lib/program.ts";

const Job = Schema.Literals(["software-update", "homebrew-update"]);
type Job = typeof Job.Type;
const Config = Schema.Record(Schema.String, Schema.String);
type Delivery = "not-configured" | "sent" | "failed";

export const runUpdate = Effect.fn("runMonitoredUpdate")(function*(
  job: Job,
  home: string,
  command: string,
  args: readonly string[],
  send: typeof fetch = fetch,
  retryWait: Effect.Effect<void> = Effect.sleep("10 seconds"),
) {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* CommandRunner;
  const startedAt = new Date().toISOString();
  const directory = join(home, ".local/state/dotfiles/updates");
  const path = join(directory, `${job}.json`);
  const configPath = join(home, ".config/dotfiles/update-heartbeats.json");
  let delivery: Delivery = "not-configured";
  const receipt = Effect.fn("writeUpdateReceipt")(function*(fields: Record<string, unknown>) {
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    yield* fs.writeFileString(temporary, `${JSON.stringify({ version: 1, job, startedAt, ...fields })}\n`, { mode: 0o600 });
    yield* fs.rename(temporary, path);
  }, Effect.catch(() => Console.error("Could not write update receipt; inspect launchd and the update log.")));

  const destination = yield* Effect.gen(function*() {
    if (!(yield* fs.exists(configPath))) return undefined;
    const link = yield* fs.readLink(configPath).pipe(Effect.option);
    const info = yield* fs.stat(configPath);
    if (Option.isSome(link) || info.type !== "File" || Option.getOrUndefined(info.uid) !== process.getuid?.() || (info.mode & 0o077) !== 0) {
      return yield* fail("heartbeat config must be an owner-only regular file");
    }
    const config = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Config))(yield* fs.readFileString(configPath));
    const value = config[job];
    if (!value) return undefined;
    const url = yield* Effect.try(() => new URL(value));
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      return yield* fail("heartbeat destinations must be HTTPS URLs without credentials, queries, or fragments");
    }
    return url.href.replace(/\/$/, "");
  }).pipe(Effect.catch(() => Effect.gen(function*() {
    delivery = "failed";
    yield* Console.error("Invalid update heartbeat configuration; updates will continue without delivery.");
    return undefined;
  })));

  yield* receipt({ state: "running" });
  const status = yield* runner.run(command, args, { output: "inherit" }).pipe(
    Effect.map(result => result.status),
    Effect.catch(() => Effect.gen(function*() {
      yield* Console.error("Update command could not start.");
      return 127;
    })),
  );
  if (destination) {
    const deliver = Effect.tryPromise(async () => {
      const response = await send(`${destination}${status === 0 ? "" : "/fail"}`, {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error("heartbeat rejected");
      return "sent" as const;
    });
    delivery = yield* deliver.pipe(
      // One bounded retry: a transient blip must not page as a missed heartbeat.
      // The update result is already final, so retrying repeats no package work.
      Effect.catch(() => retryWait.pipe(Effect.flatMap(() => deliver))),
      Effect.catch(() => Effect.gen(function*() {
        yield* Console.error("Update heartbeat delivery failed; the update will not be repeated.");
        return "failed" as const;
      })),
    );
  }
  yield* receipt({ state: "finished", finishedAt: new Date().toISOString(), exitCode: status, heartbeat: delivery });
  return status;
});

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const program = Effect.gen(function*() {
    const [job, separator, command, ...args] = process.argv.slice(2);
    if (!Schema.is(Job)(job) || separator !== "--" || !command || !process.env.HOME) {
      return yield* fail("Usage: run.ts <software-update|homebrew-update> -- COMMAND [ARGS...]", 2);
    }
    process.exitCode = yield* runUpdate(job, process.env.HOME, command, args);
  }).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));
  runMain(program);
}
