#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Schema } from "effect";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../lib/command.ts";
import { CliFailure, fail, runMain } from "../lib/program.ts";

const Sha256 = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)));
const scriptDir = resolve(dirname(fileURLToPath(import.meta.url)));

const run = Effect.fn("runTizenOnePasswordCommand")(function*(command: string, args: readonly string[], inherit = false) {
  const runner = yield* CommandRunner;
  const result = yield* runner.run(command, args, { stdin: inherit ? "inherit" : "ignore", output: inherit ? "inherit" : "capture" }).pipe(
    Effect.mapError((error) => new CliFailure({ exitCode: 1, message: `missing required command or failed to start ${command}: ${error.message}` })),
  );
  if (result.status !== 0) return yield* fail(`${command} exited ${result.status}`, result.status);
  return result;
});

const program = Effect.gen(function*() {
  const args = process.argv.slice(2);
  if (args.length > 1) return yield* fail("usage: scripts/tizen/restore-from-1password.ts [OUTPUT]", 2);
  const account = process.env.TIZEN_1PASSWORD_ACCOUNT || "";
  const reference = process.env.TIZEN_1PASSWORD_REFERENCE;
  const expectedInput = process.env.TIZEN_CERTS_SHA256;
  if (!reference) return yield* fail("TIZEN_1PASSWORD_REFERENCE is required, for example op://Vault/Item/archive", 2);
  if (!expectedInput) return yield* fail("TIZEN_CERTS_SHA256 is required", 2);
  const expected = yield* Schema.decodeUnknownEffect(Sha256)(expectedInput).pipe(
    Effect.mapError(() => new CliFailure({ exitCode: 2, message: "TIZEN_CERTS_SHA256 must be a lowercase SHA-256 digest" })),
  );
  const output = args[0] || join(process.env.HOME || "", "Downloads/tizen-certs.tar.gz");
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dirname(output), { recursive: true });
  yield* Console.log("downloading Tizen cert archive from 1Password");
  yield* Console.log(`account: ${account}`);
  yield* Console.log(`reference: ${reference}`);
  yield* Console.log(`output: ${output}`);
  const readArgs = account
    ? ["read", "--account", account, "--out-file", output, reference]
    : ["read", "--out-file", output, reference];
  yield* run("op", readArgs);
  const checksum = yield* run("shasum", ["-a", "256", output]);
  const actual = yield* Schema.decodeUnknownEffect(Sha256)(checksum.stdout.trim().split(/\s+/)[0]).pipe(
    Effect.mapError(() => new CliFailure({ exitCode: 1, message: "shasum returned an invalid SHA-256 digest" })),
  );
  if (actual !== expected) return yield* fail(`checksum mismatch for ${output}\nexpected: ${expected}\nactual:   ${actual}`);
  yield* Console.log(`checksum ok: ${actual}`);
  yield* run(join(scriptDir, "restore.ts"), [output], true);
}).pipe(
  Effect.provide(CommandRunner.layer),
  Effect.provide(NodeServices.layer),
);

runMain(program);
