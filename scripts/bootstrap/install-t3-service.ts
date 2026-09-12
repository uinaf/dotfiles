#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem } from "effect";
import { join } from "node:path";
import { CommandRunner } from "../lib/command.ts";
import { CliFailure, fail, runMain } from "../lib/program.ts";

// T3 Code's background service, installed once per devbox user. T3 owns the
// launchd/systemd plumbing and its own later updates; this step only proves
// the service exists and installs it when it does not.
export function t3ServiceUnit(home: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin"
    ? join(home, "Library/LaunchAgents/com.t3tools.t3code.service.plist")
    : join(home, ".config/systemd/user/t3code.service");
}

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* CommandRunner;
  const home = process.env.HOME || "";
  const baseDir = process.env.T3_BASE_DIR || join(home, ".t3");
  const unit = t3ServiceUnit(home);
  if (process.argv.includes("--check")) {
    if (!(yield* fs.exists(unit))) return yield* fail(`T3 Code service is not installed: ${unit}`);
    return;
  }
  const present = yield* fs.exists(unit);
  if (present && process.platform !== "linux") return yield* Console.log(`T3 Code service present: ${unit}`);
  if (process.platform === "linux") {
    // Checked for an existing unit too: revoked lingering stops the service at logout.
    const linger = yield* runner.run("loginctl", ["show-user", process.env.USER || "", "--property=Linger", "--value"], { output: "capture" }).pipe(
      Effect.mapError((error) => new CliFailure({ exitCode: 1, message: `cannot query systemd-logind: ${error.message}` })),
    );
    if (linger.status !== 0) return yield* fail(`loginctl show-user exited ${linger.status}: ${linger.stderr.trim()}`);
    if (linger.stdout.trim() !== "yes") {
      return yield* fail("T3 Code needs systemd lingering; have an administrator run: sudo loginctl enable-linger $(id -un)");
    }
  }
  if (present) return yield* Console.log(`T3 Code service present: ${unit}`);
  yield* Console.log(`installing the T3 Code service with base dir ${baseDir}`);
  const install = yield* runner.run("npx", ["--yes", "t3@latest", "service", "install", "--base-dir", baseDir], { output: "inherit" });
  if (install.status !== 0) return yield* fail(`t3 service install exited ${install.status}`, install.status);
  if (!(yield* fs.exists(unit))) return yield* fail(`t3 service install finished but ${unit} is missing`);
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

runMain(program);
