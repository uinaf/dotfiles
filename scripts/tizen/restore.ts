#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option, Terminal } from "effect";
import { join } from "node:path";
import { CommandRunner } from "../lib/command.ts";
import { CliFailure, fail, runMain } from "../lib/program.ts";

const runTar = Effect.fn("runTizenRestoreTar")(function*(home: string, archive: string) {
  const runner = yield* CommandRunner;
  const result = yield* runner.run("tar", ["-C", home, "-xzf", archive], { stdin: "inherit", output: "inherit" }).pipe(
    Effect.mapError((error) => new CliFailure({ exitCode: 1, message: error.message })),
  );
  if (result.status !== 0) return yield* fail(`tar exited ${result.status}`, result.status);
});

const program = Effect.gen(function*() {
  const args = process.argv.slice(2);
  if (args.length !== 1) return yield* fail("usage: scripts/tizen/restore.ts /path/to/tizen-migration.tar.gz", 2);
  const archive = args[0];
  const home = process.env.HOME || "";
  if (!home) return yield* fail("HOME is required");
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(archive).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "File") return yield* fail(`archive not found: ${archive}`);
  yield* Console.log(`This will restore Tizen cert/profile state into ${home}`);
  yield* Console.log(`Archive: ${archive}`);
  yield* Effect.sync(() => process.stdout.write("Press Enter to continue, or Ctrl-C to stop. "));
  const terminal = yield* Terminal.Terminal;
  yield* terminal.readLine.pipe(
    Effect.mapError(() => new CliFailure({ exitCode: 1, message: "restore cancelled" })),
  );
  yield* runTar(home, archive);
  const localBin = join(home, ".local/bin");
  yield* fs.makeDirectory(localBin, { recursive: true });
  for (const [source, name] of [
    [join(home, "tizen-studio/tools/ide/bin/tizen"), "tizen"],
    [join(home, "tizen-studio/tools/ide/bin/tizen.sh"), "tizen.sh"],
    [join(home, "tizen-studio/tools/sdb"), "sdb"],
  ] as const) {
    const sourceInfo = yield* fs.stat(source).pipe(Effect.option);
    if (Option.isSome(sourceInfo) && sourceInfo.value.type === "File" && (sourceInfo.value.mode & 0o111) !== 0) {
      const target = join(localBin, name);
      yield* fs.remove(target, { force: true });
      yield* fs.symlink(source, target);
    }
  }
  yield* Console.log("restored Tizen state");
  yield* Console.log("verify with:\n  tizen version\n  sdb version");
}).pipe(
  Effect.provide(CommandRunner.layer),
  Effect.provide(NodeServices.layer),
);

runMain(program);
