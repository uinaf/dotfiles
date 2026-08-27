#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../lib/command.ts";
import { fail, runMain } from "../lib/program.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const flagOverrides = [
  { name: "vertical-tabs", value: "vertical-tabs@1" },
  { name: "enable-lens-overlay-edu-action-chip", value: "enable-lens-overlay-edu-action-chip@2" },
] as const;
const usage = `Usage:
  scripts/bootstrap/configure-chrome.ts [options]

Enables Chrome's native vertical tabs and disables its Lens education action
chip in the local Chrome "Local State" file. Quit Chrome before running this
script so Chrome does not overwrite the change on exit.

Options:
  --state PATH       Chrome Local State path
  --disable          remove both flag overrides
  --allow-running    write even when Chrome appears to be running
  -h, --help`;

const program = Effect.gen(function*() {
  let statePath = process.env.CHROME_LOCAL_STATE || `${process.env.HOME || ""}/Library/Application Support/Google/Chrome/Local State`;
  let mode: "disable" | "enable" = "enable";
  let allowRunning = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--state") {
      const value = args[index + 1];
      if (!value) return yield* fail("--state requires a value", 2);
      statePath = value;
      index += 1;
    } else if (argument === "--disable") {
      mode = "disable";
    } else if (argument === "--allow-running") {
      allowRunning = true;
    } else if (argument === "-h" || argument === "--help") {
      yield* Console.log(usage);
      return;
    } else {
      yield* Console.error(usage);
      return yield* fail(`unsupported argument ${argument}`, 2);
    }
  }

  const runner = yield* CommandRunner;
  if (!allowRunning) {
    const running = yield* runner.run("pgrep", ["-x", "Google Chrome"]);
    if (running.status === 0) {
      return yield* fail("quit Google Chrome before changing Local State, or rerun with --allow-running");
    }
  }
  for (const flag of flagOverrides) {
    const result = yield* runner.run(process.execPath, [
      resolve(repoRoot, "scripts/bootstrap/chrome-state.ts"),
      statePath,
      mode,
      flag.name,
      flag.value,
    ], { output: "inherit" });
    if (result.status !== 0) {
      return yield* fail(`Chrome Local State update for ${flag.name} exited ${result.status}`);
    }
  }
  const summary = flagOverrides.map((flag) => mode === "enable" ? flag.value : flag.name).join(", ");
  yield* Console.log(mode === "enable"
    ? `configured Chrome flags: ${summary} in ${statePath}`
    : `removed Chrome flag overrides: ${summary} in ${statePath}`);
}).pipe(
  Effect.provide(CommandRunner.layer),
  Effect.provide(NodeServices.layer),
);

runMain(program);
