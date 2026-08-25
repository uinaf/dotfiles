#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, DateTime, Effect, FileSystem } from "effect";
import { dirname, join } from "node:path";
import { CommandRunner } from "../lib/command.ts";
import { CliFailure, fail, runMain } from "../lib/program.ts";

const runTar = Effect.fn("runTizenPackTar")(function*(home: string, output: string, paths: readonly string[]) {
  const runner = yield* CommandRunner;
  const result = yield* runner.run("tar", ["-C", home, "-czf", output, ...paths], { output: "inherit" }).pipe(
    Effect.mapError((error) => new CliFailure({ exitCode: 1, message: error.message })),
  );
  if (result.status !== 0) return yield* fail(`tar exited ${result.status}`, result.status);
});

const program = Effect.gen(function*() {
  const args = process.argv.slice(2);
  const full = args[0] === "--full";
  if (full) args.shift();
  if (args.length > 1 || args[0] === "--full") return yield* fail("usage: scripts/tizen/pack.ts [--full] [OUTPUT]", 2);
  const home = process.env.HOME || "";
  if (!home) return yield* fail("HOME is required");
  const now = yield* DateTime.now;
  const timestamp = DateTime.formatIso(now).replaceAll(/\D/g, "").slice(0, 14);
  const mode = full ? "full" : "certs";
  const output = args[0] || join(home, "Desktop", `tizen-${full ? "migration" : "certs"}-${timestamp}.tar.gz`);
  const candidates = full
    ? ["SamsungCertificate", ".tizen", "tizen-studio", "tizen-studio-data", "tizen-studio-extensions", "tizen-studio-workspace"]
    : ["SamsungCertificate", ".tizen", "tizen-studio-data/profile"];
  const fs = yield* FileSystem.FileSystem;
  const paths: string[] = [];
  for (const path of candidates) {
    if (yield* fs.exists(join(home, path))) {
      paths.push(path);
    } else {
      yield* Console.error(`skip missing ${join(home, path)}`);
    }
  }
  if (paths.length === 0) return yield* fail(`no Tizen ${mode} paths found; nothing to archive`);
  yield* fs.makeDirectory(dirname(output), { recursive: true });
  yield* runTar(home, output, paths);
  yield* Console.log(`created ${output}`);
  yield* Console.log(`mode: ${mode}`);
  yield* Console.log("contains:");
  for (const path of paths) yield* Console.log(`  ${path}`);
  yield* Console.log("\nThis archive contains signing certificates/device keys. Do not commit it.");
}).pipe(
  Effect.provide(CommandRunner.layer),
  Effect.provide(NodeServices.layer),
);

runMain(program);
