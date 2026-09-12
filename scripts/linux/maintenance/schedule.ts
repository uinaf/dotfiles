#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem } from "effect";
import { join } from "node:path";
import { CommandRunner } from "../../lib/command.ts";
import { fail, runMain } from "../../lib/program.ts";

// systemd user counterpart of scripts/darwin/maintenance/schedule.ts. chezmoi
// renders the unit and timer; this script only flips their state.
export const updateUnit = "dotfiles-software-update";
const usage = "Usage: scripts/linux/maintenance/schedule.ts <enable|disable|run|status>";

const program = Effect.gen(function*() {
  const action = process.argv[2];
  if (process.argv.length !== 3 || !["enable", "disable", "run", "status"].includes(action ?? "")) return yield* fail(usage, 2);
  const runner = yield* CommandRunner;
  const fs = yield* FileSystem.FileSystem;
  const home = process.env.HOME || "";
  const systemctl = (...args: string[]) => runner.run("systemctl", ["--user", ...args], { output: "capture" });
  const unitFile = join(home, ".config/systemd/user", `${updateUnit}.timer`);
  if (!(yield* fs.exists(unitFile))) return yield* fail(`missing ${unitFile}; run ./dotfiles apply first`);

  switch (action) {
    case "enable": {
      for (const args of [["daemon-reload"], ["enable", "--now", `${updateUnit}.timer`]]) {
        const result = yield* systemctl(...args);
        if (result.status !== 0) return yield* fail(`systemctl --user ${args.join(" ")} exited ${result.status}: ${result.stderr.trim()}`);
      }
      return yield* Console.log(`Software maintenance enabled: ${updateUnit}.timer runs every six hours.`);
    }
    case "disable": {
      yield* systemctl("disable", "--now", `${updateUnit}.timer`);
      yield* systemctl("stop", `${updateUnit}.service`);
      return yield* Console.log("Software maintenance disabled; any running update was stopped.");
    }
    case "run": {
      const result = yield* systemctl("start", "--no-block", `${updateUnit}.service`);
      if (result.status !== 0) return yield* fail(`systemctl --user start exited ${result.status}: ${result.stderr.trim()}`);
      return yield* Console.log(`Update requested; systemd keeps one instance. Log: journalctl --user -u ${updateUnit}`);
    }
    case "status": {
      const enabled = yield* systemctl("is-enabled", `${updateUnit}.timer`);
      const active = yield* systemctl("is-active", `${updateUnit}.timer`);
      const next = yield* systemctl("list-timers", "--no-pager", "--no-legend", `${updateUnit}.timer`);
      const lastRun = yield* systemctl("show", "-p", "ExecMainStatus", "-p", "ExecMainExitTimestamp", `${updateUnit}.service`);
      yield* Console.log(`timer: ${enabled.stdout.trim() || "unknown"} (${active.stdout.trim() || "unknown"})`);
      if (next.stdout.trim()) yield* Console.log(`next: ${next.stdout.trim()}`);
      yield* Console.log(lastRun.stdout.trim().split("\n").map((line) => `last ${line}`).join("\n"));
      const receipt = join(home, ".local/state/dotfiles/updates/software-update.json");
      if (yield* fs.exists(receipt)) yield* Console.log(`receipt: ${(yield* fs.readFileString(receipt)).trim()}`);
      return yield* Console.log(`log: journalctl --user -u ${updateUnit}`);
    }
  }
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

runMain(program);
