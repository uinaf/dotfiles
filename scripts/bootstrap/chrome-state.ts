#!/usr/bin/env node

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Option, Schema } from "effect";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliFailure, runMain } from "../lib/program.ts";

type Mode = "enable" | "disable";

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

export function updateChromeState(path: string, mode: Mode, flagName: string, flagValue: string): void {
  let data: Record<string, unknown> = {};
  try {
    const source = readFileSync(path, "utf8");
    try {
      data = object(JSON.parse(source), `${path} contents`);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`${path} is not valid JSON: ${error.message}`);
      throw error;
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  const browser = data.browser === undefined ? {} : object(data.browser, '"browser"');
  const current = browser.enabled_labs_experiments ?? [];
  if (!Array.isArray(current)) throw new Error('"browser.enabled_labs_experiments" must be a JSON array');
  const prefix = `${flagName}@`;
  const experiments = current.filter((item) => typeof item !== "string" || (item !== flagName && !item.startsWith(prefix)));
  if (mode === "enable") experiments.push(flagValue);
  browser.enabled_labs_experiments = experiments;
  data.browser = browser;

  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  let fileMode = 0o600;
  try {
    fileMode = statSync(path).mode & 0o7777;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const temporaryDirectory = mkdtempSync(join(directory, ".chrome-state."));
  const temporaryPath = join(temporaryDirectory, "Local State");
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(data)}\n`, { mode: fileMode });
    chmodSync(temporaryPath, fileMode);
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

const Arguments = Schema.Tuple([Schema.NonEmptyString, Schema.Literals(["enable", "disable"]), Schema.NonEmptyString, Schema.NonEmptyString]);

const updateChromeStateEffect = Effect.fn("updateChromeState")(function*(path: string, mode: Mode, flagName: string, flagValue: string) {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* fs.readFileString(path).pipe(Effect.option);
  let data: Record<string, unknown> = {};
  if (Option.isSome(source)) {
    data = yield* Effect.try({ try: () => object(JSON.parse(source.value), `${path} contents`), catch: (error) => error });
  }
  const browser = data.browser === undefined ? {} : object(data.browser, '"browser"');
  const current = browser.enabled_labs_experiments ?? [];
  if (!Array.isArray(current)) return yield* Effect.fail(new Error('"browser.enabled_labs_experiments" must be a JSON array'));
  const prefix = `${flagName}@`;
  const experiments = current.filter((item) => typeof item !== "string" || (item !== flagName && !item.startsWith(prefix)));
  if (mode === "enable") experiments.push(flagValue);
  browser.enabled_labs_experiments = experiments;
  data.browser = browser;
  const directory = dirname(path);
  yield* fs.makeDirectory(directory, { recursive: true });
  const info = yield* fs.stat(path).pipe(Effect.option);
  const fileMode = Option.isSome(info) ? info.value.mode & 0o7777 : 0o600;
  yield* Effect.scoped(Effect.gen(function*() {
    const temporaryDirectory = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".chrome-state." });
    const temporaryPath = join(temporaryDirectory, "Local State");
    yield* fs.writeFileString(temporaryPath, `${JSON.stringify(data)}\n`, { mode: fileMode });
    yield* fs.chmod(temporaryPath, fileMode);
    yield* fs.rename(temporaryPath, path);
  }));
});

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const program = Effect.gen(function*() {
    const [path, mode, flagName, flagValue] = yield* Schema.decodeUnknownEffect(Arguments)(process.argv.slice(2)).pipe(
      Effect.mapError(() => new CliFailure({ exitCode: 2, message: "Usage: scripts/bootstrap/chrome-state.ts PATH <enable|disable> FLAG VALUE" })),
    );
    yield* updateChromeStateEffect(path, mode, flagName, flagValue);
  }).pipe(Effect.provide(NodeServices.layer));
  runMain(program);
}
