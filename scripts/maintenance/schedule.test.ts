import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { NodeServices } from "@effect/platform-node";
import { CommandRunner } from "../lib/command.ts";
import { CliFailure } from "../lib/program.ts";
import { manageSchedule, updateLabel } from "./schedule.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("on-demand updates reuse the loaded service without killing its current work", async () => {
  const calls: string[][] = [];
  const runner = CommandRunner.of({ run: (command, args = []) => {
    calls.push([command, ...args]);
    return Effect.succeed({ status: 0, stdout: "loaded", stderr: "" });
  } });
  await Effect.runPromise(manageSchedule("run", "/fixture/home", 501).pipe(
    Effect.provideService(CommandRunner, runner), Effect.provide(NodeServices.layer),
  ));
  assert.deepEqual(calls, [
    ["launchctl", "print", `gui/501/${updateLabel}`],
    ["launchctl", "kickstart", `gui/501/${updateLabel}`],
  ]);
});

test("a missing job cannot silently run an uncoordinated updater", async () => {
  const calls: string[][] = [];
  const runner = CommandRunner.of({ run: (command, args = []) => {
    calls.push([command, ...args]);
    return Effect.succeed({ status: 113, stdout: "", stderr: "service not found" });
  } });
  const failure = await Effect.runPromise(manageSchedule("run", "/fixture/home", 501).pipe(
    Effect.provideService(CommandRunner, runner), Effect.provide(NodeServices.layer), Effect.flip,
  ));
  assert.match(String(failure), /enable the scheduler first/);
  assert.deepEqual(calls, [["launchctl", "print", `gui/501/${updateLabel}`]]);
});

test("on-demand launch failures reach the caller", async () => {
  const runner = CommandRunner.of({ run: (_command, args = []) =>
    Effect.succeed({ status: args[0] === "kickstart" ? 5 : 0, stdout: "", stderr: "launch failed" }),
  });
  const failure = await Effect.runPromise(manageSchedule("run", "/fixture/home", 501).pipe(
    Effect.provideService(CommandRunner, runner), Effect.provide(NodeServices.layer), Effect.flip,
  ));
  assert.ok(failure instanceof CliFailure);
  assert.equal(failure.exitCode, 5);
});

for (const loaded of [false, true]) {
  test(`disabling a ${loaded ? "loaded" : "missing"} job persists its disabled state`, async () => {
    const calls: string[][] = [];
    const runner = CommandRunner.of({ run: (command, args = []) => {
      calls.push([command, ...args]);
      return Effect.succeed({ status: args[0] === "print" && !loaded ? 113 : 0, stdout: "", stderr: "" });
    } });
    await Effect.runPromise(manageSchedule("disable", "/fixture/home", 501).pipe(
      Effect.provideService(CommandRunner, runner), Effect.provide(NodeServices.layer),
    ));
    const service = `gui/501/${updateLabel}`;
    assert.deepEqual(calls, [
      ["launchctl", "print", service],
      ["launchctl", "disable", service],
      ...(loaded ? [["launchctl", "bootout", service]] : []),
    ]);
  });
}

for (const kind of ["regular", "writable", "symlink"] as const) {
  test(`enrollment checks the ${kind} plist before enabling a job`, async (t) => {
    const uid = process.getuid?.();
    assert.ok(uid, "enrollment requires an unprivileged Unix user");
    const home = await mkdtemp(join(tmpdir(), "dotfiles-enrollment-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const plist = join(home, `Library/LaunchAgents/${updateLabel}.plist`);
    await mkdir(dirname(plist), { recursive: true });
    await mkdir(join(home, ".config/dotfiles"), { recursive: true });
    await writeFile(join(home, ".config/dotfiles/profile"), "workstation\n", { mode: 0o600 });
    await writeFile(plist, "fixture: plutil is stubbed at the process boundary", { mode: 0o600 });
    if (kind === "writable") await chmod(plist, 0o622);
    if (kind === "symlink") {
      await rm(plist);
      await symlink(join(home, ".config/dotfiles/profile"), plist);
    }
    const calls: string[][] = [];
    let loaded = false;
    const runner = CommandRunner.of({ run: (command, args = []) => {
      calls.push([command, ...args]);
      if (args[0] === "bootstrap") loaded = true;
      return Effect.succeed({ status: args[0] === "print" && !loaded ? 113 : 0, stdout: "", stderr: "" });
    } });
    const operation = manageSchedule("enable", home, uid).pipe(
      Effect.provideService(CommandRunner, runner), Effect.provide(NodeServices.layer),
    );
    const service = `gui/${uid}/${updateLabel}`;
    if (kind === "regular") {
      await Effect.runPromise(operation);
      assert.deepEqual(calls, [
        ["launchctl", "print", service],
        ["plutil", "-lint", plist],
        ["launchctl", "enable", service],
        ["launchctl", "bootstrap", `gui/${uid}`, plist],
        ["launchctl", "print", service],
      ]);
    } else {
      const failure = await Effect.runPromise(operation.pipe(Effect.flip));
      assert.match(String(failure), kind === "symlink" ? /must not be a symlink/ : /owning user/);
      assert.deepEqual(calls, [["launchctl", "print", service]]);
    }
  });
}

test("rendered profiles keep updater scope, scheduling, and paths valid", async () => {
  const root = await mkdtemp(join(tmpdir(), "dotfiles-updates-"));
  try {
    // Spaces and XML metacharacters must survive launchd's argument boundary.
    const home = join(root, "home & space");
    await mkdir(home);
    for (const profile of ["workstation", "personal-workstation", "devbox", "personal-devbox"]) {
      const render = (target: string) => {
        const result = spawnSync("chezmoi", ["--source", join(repoRoot, "chezmoi"), "--destination", home,
          "--override-data", JSON.stringify({ dotfilesProfile: profile }), "cat", join(home, target)], {
          encoding: "utf8", env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(root, "config") },
        });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
      };
      const plist = join(root, "update.plist");
      await writeFile(plist, render(`Library/LaunchAgents/${updateLabel}.plist`));
      const parsed = spawnSync("plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" });
      assert.equal(parsed.status, 0, parsed.stderr);
      const job = JSON.parse(parsed.stdout);
      assert.equal(job.Label, "local.dotfiles.software-update");
      assert.equal(job.Disabled, true, "applying dotfiles alone must not enroll a scheduler");
      assert.equal(job.RunAtLoad, true);
      assert.equal(job.KeepAlive, undefined, "failures must not spin in a restart loop");
      assert.deepEqual(job.StartCalendarInterval, [0, 6, 12, 18].map((Hour) => ({ Hour, Minute: 23 })));
      assert.deepEqual(job.ProgramArguments, [
        process.arch === "arm64" ? "/opt/homebrew/bin/topgrade" : "/usr/local/bin/topgrade",
        "--config", join(home, ".config/topgrade.toml"), "--no-tmux", "--no-ask-retry",
        "--no-self-update", "--notify-end", "on_failure", "--yes",
      ]);
      assert.equal(job.EnvironmentVariables.HOMEBREW_NO_UPGRADE_QUIT_CASKS, "1");
      assert.equal(job.EnvironmentVariables.HOMEBREW_NO_INSTALL_CLEANUP, "1");
      assert.equal(job.EnvironmentVariables.GIT_TERMINAL_PROMPT, "0");
      const config = render(".config/topgrade.toml");
      const selection = config.split("\n").find((line) => line.startsWith("only = "));
      assert.ok(selection);
      assert.deepEqual(JSON.parse(selection.slice("only = ".length)), profile.endsWith("devbox")
        ? ["github_cli_extensions", "custom_commands"]
        : ["brew_formula", "brew_cask", "github_cli_extensions", "custom_commands"]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
