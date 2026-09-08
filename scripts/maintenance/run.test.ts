import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeSync, lstatSync, openSync, readFileSync, writeSync } from "node:fs";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { CommandRunner, CommandError } from "../lib/command.ts";
import { runUpdate } from "./run.ts";
import { dailyLog, rotateUpdateLog } from "./logs.ts";

for (const scenario of ["success", "failure", "spawn", "delivery", "retried", "invalid", "unconfigured"] as const) {
  test(`update reporting preserves ${scenario} without repeating the command`, async t => {
    const home = await mkdtemp(join(tmpdir(), "dotfiles-report-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    await mkdir(join(home, ".config/dotfiles"), { recursive: true });
    const url = "https://monitor.example/secret-token";
    if (scenario !== "unconfigured") {
      await writeFile(join(home, ".config/dotfiles/update-heartbeats.json"),
        scenario === "invalid" ? "not-json" : JSON.stringify({ "software-update": url }), { mode: 0o600 });
    }
    let executions = 0;
    const sent: string[] = [];
    const expected = scenario === "failure" ? 23 : scenario === "spawn" ? 127 : 0;
    const runner = CommandRunner.of({ run: () => {
      executions++;
      return scenario === "spawn"
        ? Effect.fail(new CommandError({ command: "missing", message: "secret diagnostic" }))
        : Effect.succeed({ status: expected, stdout: "", stderr: "" });
    } });
    const rejections = scenario === "delivery" ? 2 : scenario === "retried" ? 1 : 0;
    const send: typeof fetch = async (input, init) => {
      sent.push(String(input));
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal);
      return new Response(null, { status: sent.length <= rejections ? 503 : 200 });
    };
    let waits = 0;
    const wait = Effect.sync(() => { waits += 1; });
    const result = await Effect.runPromise(runUpdate("software-update", home, "fixture", [], send, wait).pipe(
      Effect.provideService(CommandRunner, runner), Effect.provide(NodeServices.layer),
    ));
    assert.equal(result, expected);
    assert.equal(executions, 1);
    const receipt = await readFile(join(home, ".local/state/dotfiles/updates/software-update.json"), "utf8");
    assert.doesNotMatch(receipt, /secret-token|secret diagnostic/);
    assert.equal(JSON.parse(receipt).exitCode, expected);
    const historyPath = join(home, `Library/Logs/dotfiles/software-update-history-${new Date().toISOString().slice(0, 10)}.log`);
    const history = await readFile(historyPath, "utf8");
    assert.doesNotMatch(history, /secret-token|secret diagnostic/);
    const records = history.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(records.length, 2);
    assert.equal(records[0].state, "running");
    assert.equal(records[0].startedAt, records[1].startedAt);
    assert.deepEqual(records[1], JSON.parse(receipt));
    assert.equal((await stat(historyPath)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(receipt).heartbeat, scenario === "delivery" || scenario === "invalid" ? "failed"
      : scenario === "unconfigured" ? "not-configured" : "sent");
    const attempt = `${url}${expected ? "/fail" : ""}`;
    assert.deepEqual(sent, scenario === "invalid" || scenario === "unconfigured" ? []
      : scenario === "delivery" || scenario === "retried" ? [attempt, attempt] : [attempt]);
    assert.equal(waits, rejections > 0 ? 1 : 0, "exactly one bounded retry after a failed delivery");
  });
}

test("history write failure does not prevent updates or the latest receipt", async t => {
  const home = await mkdtemp(join(tmpdir(), "dotfiles-report-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "Library"), "blocks log directory");
  const runner = CommandRunner.of({ run: () => Effect.succeed({ status: 23, stdout: "", stderr: "" }) });
  const result = await Effect.runPromise(runUpdate("software-update", home, "fixture", []).pipe(
    Effect.provideService(CommandRunner, runner), Effect.provide(NodeServices.layer),
  ));
  assert.equal(result, 23);
  const receipt = JSON.parse(await readFile(join(home, ".local/state/dotfiles/updates/software-update.json"), "utf8"));
  assert.equal(receipt.exitCode, 23);
});

test("rotation preserves launchd's append descriptor and expires only owned dated logs", async t => {
  const home = await mkdtemp(join(tmpdir(), "dotfiles-logs-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const now = Date.parse("2026-09-08T12:00:00Z");
  const history = dailyLog(home, "software-update-history", now);
  const directory = join(home, "Library/Logs/dotfiles");
  const active = join(directory, "software-update.log");
  await writeFile(active, "previous run\n", { mode: 0o600 });
  await utimes(active, new Date(now), new Date(now));
  const info = lstatSync(active);
  const archive = join(directory, `software-update-${info.mtime.toISOString().replaceAll(":", "-")}.log`);
  const expired = join(directory, "hygiene-2026-09-01.log");
  const retained = join(directory, "hygiene-2026-09-02.log");
  const unrelated = join(directory, "another-app-2026-09-01.log");
  await Promise.all([expired, retained, unrelated].map(path => writeFile(path, "keep unless expired\n")));
  const fd = openSync(active, "a");
  try {
    rotateUpdateLog(home, "software-update", now);
    writeSync(fd, "new run\n");
  } finally { closeSync(fd); }
  assert.equal(lstatSync(active).ino, info.ino);
  assert.equal(readFileSync(active, "utf8"), "new run\n");
  assert.equal(readFileSync(archive, "utf8"), "previous run\n");
  await assert.rejects(readFile(expired), { code: "ENOENT" });
  assert.ok(await readFile(retained));
  assert.ok(await readFile(unrelated));
  assert.equal(history, join(directory, "software-update-history-2026-09-08.log"));
});
