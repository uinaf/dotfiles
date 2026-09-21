import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes, symlink, readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "vite-plus/test";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { CommandError, CommandRunner } from "../lib/command.ts";
import { cacheCleanup, cacheCleanupTimeoutMs } from "./cache-cleanup.ts";

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "cache-cleanup-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, "bin");
  await mkdir(bin);
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  t.onTestFinished(() => {
    process.env.PATH = previousPath;
  });
  for (const name of ["xcrun", "pnpm", "docker"])
    await writeFile(join(bin, name), "fixture", { mode: 0o755 });
  const file = async (relative: string, days: number) => {
    const path = join(home, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "preserve unless eligible");
    const when = new Date(Date.now() - days * 86400_000);
    await utimes(path, when, when);
    return path;
  };
  const calls: string[][] = [];
  const run = (
    apply: boolean,
    options: { failure?: string; spawnFailure?: boolean; probeFailure?: boolean } = {},
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const live = yield* CommandRunner;
        const runner = CommandRunner.of({
          run: (command, args = [], commandOptions) => {
            assert.equal(commandOptions?.cwd, home);
            assert.equal(commandOptions?.env?.HOME, home);
            calls.push([command, ...args]);
            if (command === options.failure)
              return options.spawnFailure
                ? Effect.fail(new CommandError({ command, message: "fixture spawn failure" }))
                : Effect.succeed({ status: 1, stdout: "", stderr: "fixture exit failure" });
            if (command === "find") return live.run("/usr/bin/find", args, commandOptions);
            return Effect.succeed({
              status: options.probeFailure && (args[0] === "info" || args[0] === "--find") ? 1 : 0,
              stdout:
                command === "df"
                  ? "Filesystem 1024-blocks Used Available Capacity Mounted\nfixture 2000000 1000000 1000000 50% /\n"
                  : "",
              stderr: "",
            });
          },
        });
        return yield* cacheCleanup(home, apply).pipe(Effect.provideService(CommandRunner, runner));
      }).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer)),
    );
  return { home, bin, file, calls, run };
}

test("cache ages match find day boundaries, dry-run preserves everything, and apply keeps exclusions", async (t) => {
  const f = await fixture(t);
  const old = await f.file("Library/Developer/Xcode/DerivedData/old\ncache", 32);
  const boundary = await f.file("Library/Developer/Xcode/DerivedData/boundary", 30.5);
  const recent = await f.file("Library/Developer/Xcode/DerivedData/recent", 1);
  const oldLog = await f.file("Library/Logs/CoreSimulator/old-log", 16);
  const boundaryLog = await f.file("Library/Logs/CoreSimulator/boundary", 14.5);
  const exclusions = await Promise.all([
    f.file("Library/Developer/Xcode/Archives/release.xcarchive", 100),
    f.file("Library/Developer/CoreSimulator/Devices/runtime", 100),
    f.file("projects/repo/source.ts", 100),
  ]);
  const dry = await f.run(false);
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /would remove 1 files/);
  await Promise.all(
    [old, oldLog, boundary, recent, boundaryLog, ...exclusions].map((path) => access(path)),
  );
  assert.ok(
    f.calls.every(
      (call) => !call.includes("-delete") && !call.includes("prune") && !call.includes("delete"),
    ),
  );
  const applied = await f.run(true);
  assert.equal(applied.status, 0);
  await assert.rejects(access(old), { code: "ENOENT" });
  await assert.rejects(access(oldLog), { code: "ENOENT" });
  await Promise.all([boundary, recent, boundaryLog, ...exclusions].map((path) => access(path)));
  assert.ok(
    f.calls.some((call) => call.join(" ") === "docker builder prune -f --filter until=168h"),
  );
  assert.ok(f.calls.some((call) => call.join(" ") === "xcrun simctl delete unavailable"));
  assert.ok(f.calls.some((call) => call.join(" ") === "pnpm store prune"));
  assert.ok(f.calls.every((call) => !["container", "image", "system"].includes(call[1] ?? "")));
});

test("cache roots and nested symlinks never cause deletion outside the selected cache", async (t) => {
  const f = await fixture(t);
  const outside = await f.file("outside/old", 100);
  const root = join(f.home, "Library/Developer/Xcode/DerivedData");
  await mkdir(join(root, ".."), { recursive: true });
  await symlink(join(f.home, "outside"), root);
  await f.file(".gradle/daemon/keep", 1);
  await symlink(join(f.home, "outside"), join(f.home, ".gradle/daemon/link"));
  assert.equal((await f.run(true)).status, 0);
  assert.equal(await readFile(outside, "utf8"), "preserve unless eligible");
});

for (const spawnFailure of [false, true]) {
  test(`cache failures aggregate and remaining cleanup continues (${spawnFailure ? "spawn" : "exit"})`, async (t) => {
    const f = await fixture(t);
    await f.file(".gradle/daemon/old", 20);
    const result = await f.run(true, { failure: "find", spawnFailure });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /warning: failed: find/);
    assert.ok(f.calls.some((call) => call[0] === "pnpm"));
    assert.ok(f.calls.some((call) => call[0] === "docker" && call[1] === "builder"));
    assert.match(result.stdout, /done used=/);
  });
}

test("optional tool probes gate cleanup and missing tools are skipped", async (t) => {
  const f = await fixture(t);
  await rm(join(f.bin, "pnpm"));
  assert.equal((await f.run(true, { probeFailure: true })).status, 0);
  assert.ok(
    f.calls.every(
      (call) => call[0] !== "pnpm" && !call.includes("delete") && !call.includes("prune"),
    ),
  );
});

test("a package cleanup failure does not hide later cleanup or disk accounting", async (t) => {
  const f = await fixture(t);
  const result = await f.run(true, { failure: "pnpm" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /warning: failed: pnpm/);
  assert.ok(f.calls.some((call) => call[0] === "docker" && call[1] === "builder"));
  assert.equal(f.calls.filter((call) => call[0] === "df").length, 2);
});

test("one total budget cancels the active command and prevents subsequent cleanup", async (t) => {
  const f = await fixture(t);
  await f.file(".gradle/daemon/old", 20);
  let cancelled = false;
  const calls: string[] = [];
  const runner = CommandRunner.of({
    run: (command) => {
      calls.push(command);
      return command === "df"
        ? Effect.sleep(10).pipe(
            Effect.as({ status: 0, stdout: "header\nfixture 2000000 1000000\n", stderr: "" }),
          )
        : Effect.never.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                cancelled = true;
              }),
            ),
          );
    },
  });
  const result = await Effect.runPromise(
    cacheCleanup(f.home, true, 40).pipe(
      Effect.provideService(CommandRunner, runner),
      Effect.provide(NodeServices.layer),
    ),
  );
  assert.equal(cacheCleanupTimeoutMs, 30 * 60_000);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /timed out after 40ms/);
  assert.equal(cancelled, true);
  assert.deepEqual(calls, ["df", "find"]);
});

test("codex session retention prunes by age while root state and recent sessions survive", async (t) => {
  const f = await fixture(t);
  const expired = await Promise.all([
    f.file(".codex/archived_sessions/2026/01/02/rollout-old.jsonl", 40),
    f.file(".codex/sessions/2026/01/02/rollout-ancient.jsonl", 100),
    f.file(".codex/visualizations/2026/01/chart.html", 40),
    f.file(".codex/.tmp/scratch", 9),
  ]);
  const retained = await Promise.all([
    f.file(".codex/archived_sessions/2026/09/01/rollout-fresh.jsonl", 20),
    f.file(".codex/sessions/2026/08/01/rollout-recent.jsonl", 60),
    f.file(".codex/visualizations/2026/09/chart.html", 20),
    f.file(".codex/.tmp/warm", 3),
  ]);
  const protectedState = await Promise.all([
    f.file(".codex/config.toml", 400),
    f.file(".codex/history.jsonl", 400),
    f.file(".codex/session_index.jsonl", 400),
    f.file(".codex/thread_history_1.sqlite", 400),
    f.file(".codex/memories/note.md", 400),
    f.file(".codex/skills/custom/SKILL.md", 400),
  ]);
  const dry = await f.run(false);
  assert.equal(dry.status, 0);
  await Promise.all([...expired, ...retained, ...protectedState].map((path) => access(path)));
  assert.equal((await f.run(true)).status, 0);
  for (const path of expired) await assert.rejects(access(path), { code: "ENOENT" });
  await Promise.all([...retained, ...protectedState].map((path) => access(path)));
});
