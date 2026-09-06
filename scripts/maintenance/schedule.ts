#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option } from "effect";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner, runChecked } from "../lib/command.ts";
import { launchdLabel, resolveLaunchdNamespaceContract } from "../lib/launchd.ts";
import { fail, runMain } from "../lib/program.ts";
import { readPersistedProfile } from "../profiles/current.ts";

export const updateLabel = "local.dotfiles.software-update";
const usage = "Usage: scripts/maintenance/schedule.ts <enable|disable|run|status>";

export const manageSchedule = Effect.fn("manageSoftwareUpdateSchedule")(function*(
  action: string,
  home: string,
  uid: number,
) {
  if (!["enable", "disable", "run", "status"].includes(action)) return yield* fail(usage, 2);
  if (!home || !home.startsWith("/") || uid <= 0) return yield* fail("a non-root macOS user home is required");
  const domain = `gui/${uid}`;
  const service = `${domain}/${updateLabel}`;
  const plist = join(home, `Library/LaunchAgents/${updateLabel}.plist`);
  const logs = join(home, "Library/Logs/dotfiles");
  const log = join(logs, "software-update.log");
  const runner = yield* CommandRunner;
  const current = yield* runner.run("launchctl", ["print", service]);

  if (action === "status") {
    yield* Console.log(`Log: ${log}`);
    if (current.status !== 0) return yield* fail("software maintenance is not loaded in this GUI session");
    yield* Console.log(current.stdout);
    return;
  }
  if (action === "run") {
    if (current.status !== 0) return yield* fail("enable the scheduler first with mise run maintenance:enable");
    // Without -k, kickstart never terminates or replaces an already-running update.
    yield* runChecked("launchctl", ["kickstart", service]);
    yield* Console.log(`Update requested; launchd keeps one instance. Log: ${log}`);
    return;
  }
  if (action === "disable") {
    yield* runChecked("launchctl", ["disable", service]);
    if (current.status === 0) yield* runChecked("launchctl", ["bootout", service]);
    yield* Console.log("Software maintenance disabled; any running update was stopped.");
    return;
  }

  const fs = yield* FileSystem.FileSystem;
  yield* readPersistedProfile(join(home, ".config/dotfiles/profile"), uid);
  const user = (yield* runChecked("id", ["-un", String(uid)])).stdout.trim();
  const namespace = yield* resolveLaunchdNamespaceContract("", join(home, ".config/dotfiles/launchd-namespace"), uid);
  const systemLabel = launchdLabel("software-update", user, namespace);
  if (yield* fs.exists(`/Library/LaunchDaemons/${systemLabel}.plist`)) {
    return yield* fail(`system updater already enrolled: ${systemLabel}; use its launchctl commands`);
  }
  const link = yield* fs.readLink(plist).pipe(Effect.option);
  if (Option.isSome(link)) return yield* fail("the managed scheduler plist must not be a symlink");
  const info = yield* fs.stat(plist);
  if (info.type !== "File" || Option.getOrUndefined(info.uid) !== uid || (info.mode & 0o022) !== 0) {
    return yield* fail("apply the managed scheduler plist as its owning user first");
  }
  yield* runChecked("plutil", ["-lint", plist]);
  yield* fs.makeDirectory(logs, { recursive: true, mode: 0o700 });
  yield* runChecked("launchctl", ["enable", service]);
  if (current.status !== 0) yield* runChecked("launchctl", ["bootstrap", domain, plist]);
  yield* runChecked("launchctl", ["print", service]);
  yield* Console.log("Software maintenance enabled: every six hours at :23 local time and on login/load.");
  if (current.status === 0) yield* Console.log("Existing job retained. To load changed plist settings, disable then enable after updates finish.");
});

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const program = Effect.gen(function*() {
    if (process.platform !== "darwin") return yield* fail("software maintenance scheduling requires macOS");
    if (process.argv.length !== 3) return yield* fail(usage, 2);
    yield* manageSchedule(process.argv[2], process.env.HOME || "", process.getuid?.() ?? -1);
  }).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));
  runMain(program);
}
