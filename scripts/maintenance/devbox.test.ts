import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Option } from "effect";
import { CommandRunner } from "../lib/command.ts";
import { installUpdateJobs, updateJobs } from "./devbox.ts";

test("system jobs keep Homebrew with its owner and per-user Topgrade headless", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dotfiles-system-updates-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const homebrew of [true, false]) {
    const target = { user: "example", uid: 502, group: "staff", home: "/Users/example & space" };
    const repository = join(target.home, "projects/dotfiles");
    const jobs = updateJobs({ target, repository, node: "/fixture/node", namespace: "local.dotfiles", homebrew, check: false }, "/opt/homebrew");
    assert.equal(jobs.length, homebrew ? 2 : 1);
    for (const job of jobs) {
      const path = join(root, `${job.label}.plist`);
      await writeFile(path, job.xml);
      const result = spawnSync("plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      const plist = JSON.parse(result.stdout);
      assert.equal(plist.UserName, "example");
      assert.equal(plist.GroupName, "staff");
      assert.equal(plist.WorkingDirectory, repository);
      assert.equal(plist.EnvironmentVariables.HOME, target.home);
      assert.equal(plist.EnvironmentVariables.HOMEBREW_NO_AUTO_UPDATE, "1");
      assert.equal(plist.EnvironmentVariables.HOMEBREW_NO_INSTALL_CLEANUP, "1");
      assert.equal(plist.EnvironmentVariables.HOMEBREW_NO_UPGRADE_QUIT_CASKS, "1");
      assert.equal(plist.RunAtLoad, true);
      assert.equal(plist.KeepAlive, false);
      assert.equal(plist.SessionCreate, true);
      assert.equal(plist.Umask, 0o077);
      assert.equal(plist.StandardOutPath, plist.StandardErrorPath);
      const brewJob = job.label === "local.dotfiles.homebrew-update.example";
      assert.deepEqual(plist.StartCalendarInterval, [0, 6, 12, 18].map((Hour) => ({ Hour, Minute: brewJob ? 23 : 35 })));
      assert.deepEqual(plist.ProgramArguments, brewJob
        ? ["/fixture/node", join(repository, "scripts/bootstrap/brew-devbox.ts"), "--update-software"]
        : ["/opt/homebrew/bin/topgrade", "--config", join(target.home, ".config/topgrade.toml"),
          "--only", "github_cli_extensions", "custom_commands", "--no-tmux", "--no-ask-retry",
          "--no-self-update", "--notify-end", "never", "--yes"]);
    }
  }
});

test("a consumer cannot enroll the shared-prefix updater", async (t) => {
  const uid = process.getuid?.();
  assert.ok(uid);
  const home = await mkdtemp(join(tmpdir(), "dotfiles-update-owner-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const repository = join(home, "repo");
  await mkdir(join(repository, "scripts/bootstrap"), { recursive: true });
  await mkdir(join(home, ".config/dotfiles"), { recursive: true });
  await writeFile(join(home, ".config/dotfiles/profile"), "devbox\n", { mode: 0o600 });
  await writeFile(join(home, ".config/topgrade.toml"), "", { mode: 0o600 });
  await writeFile(join(repository, "scripts/bootstrap/brew-devbox.ts"), "", { mode: 0o600 });
  const commands: string[] = [];
  const runner = CommandRunner.of({ run: (command) => {
    commands.push(command);
    return Effect.succeed({ status: 0, stdout: command.endsWith("/brew") ? "/fixture/prefix\n" : "", stderr: "" });
  } });
  const failure = await Effect.runPromise(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(home);
    return yield* installUpdateJobs({ target: { user: "example", uid, group: "staff", home },
      repository, node: "/fixture/node", namespace: "local.dotfiles", homebrew: true, check: true,
    }).pipe(Effect.provideService(FileSystem.FileSystem, {
      ...fs, stat: (path) => path === "/fixture/prefix" ? Effect.succeed({ ...info, uid: Option.some(uid + 1) }) : fs.stat(path),
    }), Effect.flip);
  }).pipe(Effect.provide(NodeServices.layer), Effect.provideService(CommandRunner, runner)));
  assert.match(String(failure), /only the shared Homebrew prefix owner/);
  assert.equal(commands.some((command) => command.endsWith("/launchctl")), false);
});
