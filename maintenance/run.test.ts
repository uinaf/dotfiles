import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { closeSync, lstatSync, openSync, readFileSync, writeSync } from "node:fs";
import { NodeServices } from "@effect/platform-node";
import { Effect, Exit } from "effect";
import { CommandError, CommandRunner } from "../lib/command.ts";
import { BoundedCommand } from "./bounded-command.ts";
import { runUpdate } from "./run.ts";
import { dailyLog, logDirectory, rotateUpdateLog } from "./logs.ts";

for (const scenario of [
  "success",
  "failure",
  "timeout",
  "spawn",
  "delivery",
  "retried",
  "invalid",
  "unconfigured",
] as const) {
  test(`update reporting preserves ${scenario} without repeating the command`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), "dotfiles-report-"));
    t.onTestFinished(() => rm(home, { recursive: true, force: true }));
    await mkdir(join(home, ".config/dotfiles"), { recursive: true });
    const url = "https://monitor.example/secret-token";
    if (scenario !== "unconfigured") {
      await writeFile(
        join(home, ".config/dotfiles/update-heartbeats.json"),
        scenario === "invalid" ? "not-json" : JSON.stringify({ "software-update": url }),
        { mode: 0o600 },
      );
    }
    let executions = 0;
    const sent: string[] = [];
    const expected =
      scenario === "failure" ? 23 : scenario === "spawn" ? 127 : scenario === "timeout" ? 124 : 0;
    const runner = BoundedCommand.of({
      run: () => {
        executions++;
        return scenario === "spawn"
          ? Effect.fail(new CommandError({ command: "missing", message: "secret diagnostic" }))
          : Effect.succeed({
              status: expected,
              timedOut: scenario === "timeout",
              cleanupComplete: true,
            });
      },
    });
    const rejections = scenario === "delivery" ? 2 : scenario === "retried" ? 1 : 0;
    const send: typeof fetch = async (input, init) => {
      sent.push(input instanceof Request ? input.url : input.toString());
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal);
      return new Response(null, { status: sent.length <= rejections ? 503 : 200 });
    };
    let waits = 0;
    const wait = Effect.sync(() => {
      waits += 1;
    });
    const result = await Effect.runPromise(
      runUpdate("software-update", home, "fixture", [], send, wait).pipe(
        Effect.provideService(BoundedCommand, runner),
        Effect.provide(NodeServices.layer),
      ),
    );
    assert.equal(result, expected);
    assert.equal(executions, 1);
    const receipt = await readFile(
      join(home, ".local/state/dotfiles/updates/software-update.json"),
      "utf8",
    );
    assert.doesNotMatch(receipt, /secret-token|secret diagnostic/);
    assert.equal(JSON.parse(receipt).exitCode, expected);
    assert.equal(JSON.parse(receipt).timedOut, scenario === "timeout" ? true : undefined);
    const historyPath = join(
      logDirectory(home),
      `software-update-history-${new Date().toISOString().slice(0, 10)}.log`,
    );
    const history = await readFile(historyPath, "utf8");
    assert.doesNotMatch(history, /secret-token|secret diagnostic/);
    const records = history
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 3);
    assert.equal(records[0].state, "running");
    assert.equal(records[0].cleanupComplete, false);
    assert.equal(records[0].startedAt, records[2].startedAt);
    assert.deepEqual(records[2], JSON.parse(receipt));
    assert.equal((await stat(historyPath)).mode & 0o777, 0o600);
    assert.equal(
      JSON.parse(receipt).heartbeat,
      scenario === "delivery" || scenario === "invalid"
        ? "failed"
        : scenario === "unconfigured"
          ? "not-configured"
          : "sent",
    );
    const attempt = `${url}${expected ? "/fail" : ""}`;
    assert.deepEqual(
      sent,
      scenario === "invalid" || scenario === "unconfigured"
        ? []
        : scenario === "delivery" || scenario === "retried"
          ? [attempt, attempt]
          : [attempt],
    );
    assert.equal(
      waits,
      rejections > 0 ? 1 : 0,
      "exactly one bounded retry after a failed delivery",
    );
  });
}

test("history write failure does not prevent updates or the latest receipt", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dotfiles-report-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "Library"), "blocks log directory");
  const runner = BoundedCommand.of({
    run: () => Effect.succeed({ status: 23, timedOut: false, cleanupComplete: true }),
  });
  const result = await Effect.runPromise(
    runUpdate("software-update", home, "fixture", []).pipe(
      Effect.provideService(BoundedCommand, runner),
      Effect.provide(NodeServices.layer),
    ),
  );
  assert.equal(result, 23);
  const receipt = JSON.parse(
    await readFile(join(home, ".local/state/dotfiles/updates/software-update.json"), "utf8"),
  );
  assert.equal(receipt.exitCode, 23);
});

test("rotation preserves launchd's append descriptor and expires only owned dated logs", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dotfiles-logs-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  const now = Date.parse("2026-09-08T12:00:00Z");
  const history = dailyLog(home, "software-update-history", now);
  const directory = logDirectory(home);
  const active = join(directory, "software-update.log");
  await writeFile(active, "previous run\n", { mode: 0o600 });
  await utimes(active, new Date(now), new Date(now));
  const info = lstatSync(active);
  const archive = join(
    directory,
    `software-update-${info.mtime.toISOString().replaceAll(":", "-")}.log`,
  );
  const expired = join(directory, "hygiene-2026-09-01.log");
  const retained = join(directory, "hygiene-2026-09-02.log");
  const unrelated = join(directory, "another-app-2026-09-01.log");
  await Promise.all(
    [expired, retained, unrelated].map((path) => writeFile(path, "keep unless expired\n")),
  );
  const fd = openSync(active, "a");
  try {
    rotateUpdateLog(home, "software-update", now);
    writeSync(fd, "new run\n");
  } finally {
    closeSync(fd);
  }
  assert.equal(lstatSync(active).ino, info.ino);
  assert.equal(readFileSync(active, "utf8"), "new run\n");
  assert.equal(readFileSync(archive, "utf8"), "previous run\n");
  await assert.rejects(readFile(expired), { code: "ENOENT" });
  assert.ok(await readFile(retained));
  assert.ok(await readFile(unrelated));
  assert.equal(history, join(directory, "software-update-history-2026-09-08.log"));
});

for (const status of ["network", 400, 401, 403, 404, 408, 429, 500, 503] as const) {
  test(`heartbeat HTTP ${status} preserves the update result and retries only transient failures`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), "dotfiles-heartbeat-status-"));
    t.onTestFinished(() => rm(home, { recursive: true, force: true }));
    await mkdir(join(home, ".config/dotfiles"), { recursive: true });
    await writeFile(
      join(home, ".config/dotfiles/update-heartbeats.json"),
      JSON.stringify({ "software-update": "https://monitor.example/fixture" }),
      { mode: 0o600 },
    );
    let commands = 0;
    let sends = 0;
    let waits = 0;
    const runner = BoundedCommand.of({
      run: () => {
        commands++;
        return Effect.succeed({ status: 23, timedOut: false, cleanupComplete: true });
      },
    });
    const send: typeof fetch = async () => {
      sends++;
      if (status === "network") throw new TypeError("fetch failed");
      return new Response(null, { status });
    };
    const result = await Effect.runPromise(
      runUpdate(
        "software-update",
        home,
        "fixture",
        [],
        send,
        Effect.sync(() => {
          waits++;
        }),
      ).pipe(Effect.provideService(BoundedCommand, runner), Effect.provide(NodeServices.layer)),
    );
    assert.equal(result, 23);
    assert.equal(commands, 1);
    const retryable = status === "network" || status === 408 || status === 429 || status >= 500;
    assert.equal(sends, retryable ? 2 : 1);
    assert.equal(waits, retryable ? 1 : 0);
    const receipt = JSON.parse(
      await readFile(join(home, ".local/state/dotfiles/updates/software-update.json"), "utf8"),
    );
    assert.equal(receipt.exitCode, 23);
    assert.equal(receipt.heartbeat, "failed");
  });
}

test("interrupting heartbeat delivery aborts fetch without retrying the update or heartbeat", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dotfiles-heartbeat-cancel-"));
  await mkdir(join(home, ".config/dotfiles"), { recursive: true });
  await writeFile(
    join(home, ".config/dotfiles/update-heartbeats.json"),
    JSON.stringify({ "software-update": "https://monitor.example/fixture" }),
    { mode: 0o600 },
  );
  let commands = 0;
  let sends = 0;
  let waits = 0;
  let aborted = false;
  const started = Promise.withResolvers<void>();
  const controller = new AbortController();
  const runner = BoundedCommand.of({
    run: () => {
      commands++;
      return Effect.succeed({ status: 0, timedOut: false, cleanupComplete: true });
    },
  });
  const send: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      sends++;
      assert.ok(init?.signal);
      init.signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(new Error("aborted"));
        },
        { once: true },
      );
      started.resolve();
    });
  const completion = Effect.runPromiseExit(
    runUpdate(
      "software-update",
      home,
      "fixture",
      [],
      send,
      Effect.sync(() => {
        waits++;
      }),
    ).pipe(Effect.provideService(BoundedCommand, runner), Effect.provide(NodeServices.layer)),
    { signal: controller.signal },
  );
  t.onTestFinished(async () => {
    controller.abort();
    await completion;
    await rm(home, { recursive: true, force: true });
  });
  await started.promise;
  controller.abort();
  assert.equal(Exit.isFailure(await completion), true);
  assert.equal(aborted, true);
  assert.equal(commands, 1);
  assert.equal(sends, 1);
  assert.equal(waits, 0);
});

test("a real timeout sends failure and a following run replaces the failed receipt", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dotfiles-update-deadline-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".config/dotfiles"), { recursive: true });
  await writeFile(
    join(home, ".config/dotfiles/update-heartbeats.json"),
    JSON.stringify({ "software-update": "https://monitor.example/private-token" }),
    { mode: 0o600 },
  );
  const sent: string[] = [];
  const send: typeof fetch = async (input) => {
    sent.push(input instanceof Request ? input.url : input.toString());
    return new Response(null, { status: 200 });
  };
  const receiptPath = join(home, ".local/state/dotfiles/updates/software-update.json");
  const execute = (script: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const bounded = yield* BoundedCommand;
        return yield* runUpdate(
          "software-update",
          home,
          process.execPath,
          ["-e", script],
          send,
        ).pipe(
          Effect.provideService(
            BoundedCommand,
            BoundedCommand.of({
              run: (command, args, options) =>
                bounded.run(command, args, {
                  ...options,
                  timeoutMs: 1_000,
                  termGraceMs: 100,
                  pollIntervalMs: 50,
                }),
            }),
          ),
        );
      }).pipe(
        Effect.provide(BoundedCommand.layer),
        Effect.provide(CommandRunner.layer),
        Effect.provide(NodeServices.layer),
      ),
    );
  assert.equal(await execute("setInterval(() => {}, 1000)"), 124);
  const failure = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(failure.state, "finished");
  assert.equal(failure.timedOut, true);
  assert.equal(failure.cleanupComplete, true);
  assert.equal(failure.heartbeat, "sent");
  assert.equal(await execute("process.exit(0)"), 0);
  const recovery = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(recovery.exitCode, 0);
  assert.equal(recovery.timedOut, undefined);
  assert.equal(recovery.heartbeat, "sent");
  assert.deepEqual(sent, [
    "https://monitor.example/private-token/fail",
    "https://monitor.example/private-token",
  ]);
});

for (const previous of ["incomplete", "unreadable"] as const) {
  test(`a ${previous} cleanup receipt prevents the next update from overlapping`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), "dotfiles-update-blocked-"));
    t.onTestFinished(() => rm(home, { recursive: true, force: true }));
    const directory = join(home, ".local/state/dotfiles/updates");
    await mkdir(directory, { recursive: true });
    const path = join(directory, "software-update.json");
    await writeFile(
      path,
      previous === "incomplete" ? JSON.stringify({ cleanupComplete: false }) : "invalid",
    );
    let executions = 0;
    const runner = BoundedCommand.of({
      run: () => {
        executions++;
        return Effect.succeed({ status: 0, timedOut: false, cleanupComplete: true });
      },
    });
    const execute = () =>
      Effect.runPromise(
        runUpdate("software-update", home, "fixture", []).pipe(
          Effect.provideService(BoundedCommand, runner),
          Effect.provide(NodeServices.layer),
        ),
      );
    assert.equal(await execute(), 125);
    assert.equal(await execute(), 125);
    assert.equal(executions, 0);
    assert.equal(JSON.parse(await readFile(path, "utf8")).cleanupComplete, false);
    await rm(path);
    assert.equal(await execute(), 0);
    assert.equal(executions, 1);
  });
}

test("interrupted failure delivery retains the cleanup gate", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dotfiles-update-interrupted-"));
  await mkdir(join(home, ".config/dotfiles"), { recursive: true });
  await writeFile(
    join(home, ".config/dotfiles/update-heartbeats.json"),
    JSON.stringify({
      "software-update": "https://monitor.example/fixture",
    }),
    { mode: 0o600 },
  );
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  let executions = 0;
  const runner = BoundedCommand.of({
    run: () => {
      executions++;
      return Effect.succeed({ status: 124, timedOut: true, cleanupComplete: false });
    },
  });
  const send: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      assert.ok(init?.signal);
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      started.resolve();
    });
  const completion = Effect.runPromiseExit(
    runUpdate("software-update", home, "fixture", [], send).pipe(
      Effect.provideService(BoundedCommand, runner),
      Effect.provide(NodeServices.layer),
    ),
    { signal: controller.signal },
  );
  t.onTestFinished(async () => {
    controller.abort();
    await completion;
    await rm(home, { recursive: true, force: true });
  });
  await started.promise;
  controller.abort();
  assert.equal(Exit.isFailure(await completion), true);
  const receipt = JSON.parse(
    await readFile(join(home, ".local/state/dotfiles/updates/software-update.json"), "utf8"),
  );
  assert.equal(receipt.cleanupComplete, false);
  const result = await Effect.runPromise(
    runUpdate(
      "software-update",
      home,
      "fixture",
      [],
      async () => new Response(null, { status: 200 }),
    ).pipe(Effect.provideService(BoundedCommand, runner), Effect.provide(NodeServices.layer)),
  );
  assert.equal(result, 125);
  assert.equal(executions, 1);
});
