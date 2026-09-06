import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { CommandRunner } from "../lib/command.ts";
import { CliFailure } from "../lib/program.ts";
import { pruneOlderBackups, retireLaunchAgents, retiredAgentLabels } from "./apply-dotfiles.ts";

test("only the most recent timestamped backup per target survives pruning", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dotfiles-backups-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "local.dotfiles.software-update.plist");
  await writeFile(target, "managed content");
  await writeFile(`${target}.backup.20240101010101`, "oldest");
  await mkdir(`${target}.backup.20250101010101`); // a backed-up directory is removed recursively
  await symlink(target, `${target}.backup.20250601010101`);
  await writeFile(`${target}.backup.20260101010101`, "newest");
  await writeFile(`${target}.backup.notatimestamp`, "unrelated suffix");
  await writeFile(join(root, "other.plist.backup.20200101010101"), "different target");
  await Effect.runPromise(pruneOlderBackups(target).pipe(Effect.provide(NodeServices.layer)));
  assert.deepEqual((await readdir(root)).sort(), [
    "local.dotfiles.software-update.plist",
    "local.dotfiles.software-update.plist.backup.20260101010101",
    "local.dotfiles.software-update.plist.backup.notatimestamp",
    "other.plist.backup.20200101010101",
  ]);
});

test("the backup written by this run survives pruning even when the host clock is behind", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dotfiles-backups-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const target = join(root, "config");
  await writeFile(target, "current");
  await writeFile(`${target}.backup.20240101010101`, "old");
  await writeFile(`${target}.backup.20270101010101`, "written by a host whose clock ran ahead");
  const created = `${target}.backup.20260101010101`; // this run, lexically older than the existing one
  await writeFile(created, "just written");
  await Effect.runPromise(pruneOlderBackups(target, created).pipe(Effect.provide(NodeServices.layer)));
  assert.deepEqual((await readdir(root)).sort(), ["config", "config.backup.20260101010101"]);
});

test("a single backup and a backup-free target are left untouched", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dotfiles-backups-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "config");
  await writeFile(target, "managed content");
  await Effect.runPromise(pruneOlderBackups(target).pipe(Effect.provide(NodeServices.layer)));
  await writeFile(`${target}.backup.20260101010101`, "only backup");
  await Effect.runPromise(pruneOlderBackups(target).pipe(Effect.provide(NodeServices.layer)));
  assert.deepEqual((await readdir(root)).sort(), ["config", "config.backup.20260101010101"]);
});

function launchctlRunner(loaded: boolean, bootoutStatus = 0) {
  const calls: string[][] = [];
  const runner = CommandRunner.of({ run: (command, args = []) => {
    calls.push([command, ...args]);
    const status = args[0] === "print" ? (loaded ? 0 : 113) : bootoutStatus;
    return Effect.succeed({ status, stdout: "", stderr: "" });
  } });
  return { calls, runner };
}

test("a loaded retired LaunchAgent is booted out exactly once", async () => {
  const { calls, runner } = launchctlRunner(true);
  await Effect.runPromise(retireLaunchAgents(501, false, "darwin").pipe(Effect.provideService(CommandRunner, runner)));
  assert.deepEqual(calls, retiredAgentLabels.flatMap((label) => [
    ["launchctl", "print", `gui/501/${label}`],
    ["launchctl", "bootout", `gui/501/${label}`],
  ]));
});

test("a retired LaunchAgent that is not loaded is left alone", async () => {
  const { calls, runner } = launchctlRunner(false);
  await Effect.runPromise(retireLaunchAgents(501, false, "darwin").pipe(Effect.provideService(CommandRunner, runner)));
  assert.deepEqual(calls, retiredAgentLabels.map((label) => ["launchctl", "print", `gui/501/${label}`]));
});

test("dry runs and non-macOS hosts never boot out anything", async () => {
  const dry = launchctlRunner(true);
  await Effect.runPromise(retireLaunchAgents(501, true, "darwin").pipe(Effect.provideService(CommandRunner, dry.runner)));
  assert.ok(dry.calls.every((call) => call[1] === "print"));
  const linux = launchctlRunner(true);
  await Effect.runPromise(retireLaunchAgents(501, false, "linux").pipe(Effect.provideService(CommandRunner, linux.runner)));
  assert.deepEqual(linux.calls, []);
});

test("a failed bootout surfaces its launchctl status", async () => {
  const { runner } = launchctlRunner(true, 5);
  const failure = await Effect.runPromise(retireLaunchAgents(501, false, "darwin").pipe(
    Effect.provideService(CommandRunner, runner), Effect.flip,
  ));
  assert.ok(failure instanceof CliFailure);
  assert.equal(failure.exitCode, 5);
});
