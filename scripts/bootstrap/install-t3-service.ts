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
  const check = process.argv.includes("--check");
  const present = yield* fs.exists(unit);
  if (check && !present) return yield* fail(`T3 Code service is not installed: ${unit}`);
  if (present && process.platform !== "linux") return check ? undefined : yield* Console.log(`T3 Code service present: ${unit}`);
  if (process.platform === "linux") {
    // Checked for an existing unit and under --check too: revoked lingering
    // stops the service at logout.
    const linger = yield* runner.run("loginctl", ["show-user", process.env.USER || "", "--property=Linger", "--value"], { output: "capture" }).pipe(
      Effect.mapError((error) => new CliFailure({ exitCode: 1, message: `cannot query systemd-logind: ${error.message}` })),
    );
    if (linger.status !== 0) return yield* fail(`loginctl show-user exited ${linger.status}: ${linger.stderr.trim()}`);
    if (linger.stdout.trim() !== "yes") {
      return yield* fail("T3 Code needs systemd lingering; have an administrator run: sudo loginctl enable-linger $(id -un)");
    }
  }
  if (check) return;
  if (present) return yield* Console.log(`T3 Code service present: ${unit}`);
  yield* Console.log(`installing the T3 Code service with base dir ${baseDir}`);
  const install = yield* runner.run("npx", ["--yes", "t3@latest", "service", "install", "--base-dir", baseDir], { output: "inherit" });
  const installed = yield* fs.exists(unit);
  // Over SSH with nobody at the Mac's screen, T3 writes the LaunchAgent and then
  // fails to start it in the GUI domain; upstream documents that the service
  // starts at the next login.
  if (install.status !== 0 && installed && process.platform === "darwin") {
    // t3 exits a generic 1 for the headless start failure, so T3's own status
    // is the evidence: a partial or corrupt install does not report installed.
    const status = yield* runner.run("npx", ["--yes", "t3@latest", "service", "status", "--base-dir", baseDir], { output: "capture" });
    if (status.status === 0 && /^\s*Status:\s*installed\b/m.test(status.stdout)) {
      return yield* Console.log(`T3 Code service installed at ${unit}; start deferred to the next GUI login (t3 exited ${install.status})`);
    }
  }
  if (install.status !== 0) return yield* fail(`t3 service install exited ${install.status}`, install.status);
  if (!installed) return yield* fail(`t3 service install finished but ${unit} is missing`);
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

runMain(program);
