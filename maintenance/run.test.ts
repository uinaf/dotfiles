import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { closeSync, lstatSync, openSync, readFileSync, writeSync } from "node:fs";
import { NodeServices } from "@effect/platform-node";
import { Effect, Exit, FileSystem } from "effect";
import { CommandRunner } from "../lib/command.ts";
import { BoundedCommand, BoundedCommandError } from "./bounded-command.ts";
import { runUpdate } from "./run.ts";
import { dailyLog, logDirectory, rotateUpdateLog } from "./logs.ts";

const alertConfig = {
  endpoint: "https://mail.example/v4/accounts/fixture/email/sending/send",
  token: "secret-token",
  from: "alerts@example.test",
  to: "admin@example.test",
};

const writeAlertConfig = (home: string, content = JSON.stringify(alertConfig)) =>
  mkdir(join(home, ".config/dotfiles"), { recursive: true }).then(() =>
    writeFile(join(home, ".config/dotfiles/update-alerts.json"), content, { mode: 0o600 }),
  );

const accepted = (overrides: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      success: true,
      result: { delivered: [], queued: [alertConfig.to], permanent_bounces: [], ...overrides },
    }),
    { status: 200 },
  );

type SentAlert = { url: string; token: string | undefined; subject: string; text: string };

const recordingSender = (sent: SentAlert[], respond: () => Response = () => accepted()) =>
  (async (input, init) => {
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    assert.equal(typeof init?.body, "string");
    const body = JSON.parse(init.body as string);
    assert.equal(body.from, alertConfig.from);
    assert.equal(body.to, alertConfig.to);
    sent.push({
      url: input instanceof Request ? input.url : input.toString(),
      token: new Headers(init?.headers).get("authorization") ?? undefined,
      subject: body.subject,
      text: body.text,
    });
    return respond();
  }) satisfies typeof fetch;

for (const scenario of [
  "success",
  "failure",
  "timeout",
  "spawn",
  "rejected",
  "invalid",
  "unconfigured",
] as const) {
  test(`update reporting preserves ${scenario} without repeating the command`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), "dotfiles-report-"));
    t.onTestFinished(() => rm(home, { recursive: true, force: true }));
    if (scenario !== "unconfigured")
      await writeAlertConfig(home, scenario === "invalid" ? "not-json" : undefined);
    let executions = 0;
    const sent: SentAlert[] = [];
    const expected =
      scenario === "failure" || scenario === "rejected"
        ? 23
        : scenario === "spawn"
          ? 127
          : scenario === "timeout"
            ? 124
            : 0;
    const runner = BoundedCommand.of({
      run: () => {
        executions++;
        return scenario === "spawn"
          ? Effect.fail(
              new BoundedCommandError({
                cause: new Error("secret diagnostic"),
                cleanupComplete: true,
              }),
            )
          : Effect.succeed({
              status: expected,
              timedOut: scenario === "timeout",
              cleanupComplete: true,
            });
      },
    });
    const send = recordingSender(sent, () =>
      scenario === "rejected" ? new Response(null, { status: 503 }) : accepted(),
    );
    const result = await Effect.runPromise(
      runUpdate("software-update", home, "fixture", [], send).pipe(
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
      JSON.parse(receipt).alert,
      scenario === "rejected" || scenario === "invalid"
        ? "failed"
        : scenario === "unconfigured"
          ? "not-configured"
          : scenario === "success"
            ? "not-needed"
            : "sent",
    );
    const alerted = expected !== 0 && scenario !== "invalid";
    assert.equal(sent.length, alerted ? 1 : 0, "one attempt, never retried");
    if (alerted) {
      assert.equal(sent[0].url, alertConfig.endpoint);
      assert.equal(sent[0].token, "Bearer secret-token");
      assert.match(
        sent[0].subject,
        new RegExp(`software-update failed with exit code ${expected}$`),
      );
      assert.match(sent[0].text, new RegExp(`Exit code: ${expected}\n`));
      assert.doesNotMatch(sent[0].text, /secret-token|secret diagnostic/);
      assert.equal(/Timed out: yes/.test(sent[0].text), scenario === "timeout");
    }
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

for (const outcome of ["network", 401, 500, "malformed", "unacknowledged", "bounced"] as const) {
  test(`an unconfirmed ${outcome} alert is not retried and stays pending for the next run`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), "dotfiles-alert-outcome-"));
    t.onTestFinished(() => rm(home, { recursive: true, force: true }));
    await writeAlertConfig(home);
    let commands = 0;
    const sent: SentAlert[] = [];
    const runner = BoundedCommand.of({
      run: () => {
        commands++;
        return Effect.succeed({ status: 23, timedOut: false, cleanupComplete: true });
      },
    });
    const failing = recordingSender(sent, () => {
      if (outcome === "network") throw new TypeError("fetch failed");
      if (typeof outcome === "number") return new Response(null, { status: outcome });
      if (outcome === "malformed") return new Response("<html>", { status: 200 });
      return outcome === "bounced"
        ? accepted({ permanent_bounces: [alertConfig.to] })
        : accepted({ queued: [] });
    });
    const execute = (send: typeof fetch) =>
      Effect.runPromise(
        runUpdate("software-update", home, "fixture", [], send).pipe(
          Effect.provideService(BoundedCommand, runner),
          Effect.provide(NodeServices.layer),
        ),
      );
    const receiptPath = join(home, ".local/state/dotfiles/updates/software-update.json");
    assert.equal(await execute(failing), 23);
    assert.equal(commands, 1);
    assert.equal(sent.length, 1);
    assert.equal(JSON.parse(await readFile(receiptPath, "utf8")).alert, "failed");
    assert.equal(await execute(recordingSender(sent)), 23);
    assert.equal(sent.length, 2, "the next failing run delivers the pending alert");
    assert.equal(JSON.parse(await readFile(receiptPath, "utf8")).alert, "sent");
  });
}

test("interrupting alert delivery aborts fetch without retrying the update or alert", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dotfiles-alert-cancel-"));
  await writeAlertConfig(home);
  let commands = 0;
  let sends = 0;
  let aborted = false;
  const started = Promise.withResolvers<void>();
  const controller = new AbortController();
  const runner = BoundedCommand.of({
    run: () => {
      commands++;
      return Effect.succeed({ status: 1, timedOut: false, cleanupComplete: true });
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
  assert.equal(aborted, true);
  assert.equal(commands, 1);
  assert.equal(sends, 1);
});

test("alerts follow transitions: one failure email, silence while failing, one recovery email", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dotfiles-update-deadline-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  await writeAlertConfig(home);
  const sent: SentAlert[] = [];
  const send = recordingSender(sent);
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
  const alertOf = async () => JSON.parse(await readFile(receiptPath, "utf8")).alert;
  assert.equal(await execute("process.exit(0)"), 0);
  assert.equal(await alertOf(), "not-needed");
  assert.equal(await execute("setInterval(() => {}, 1000)"), 124);
  const failure = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(failure.state, "finished");
  assert.equal(failure.timedOut, true);
  assert.equal(failure.cleanupComplete, true);
  assert.equal(failure.alert, "sent");
  assert.equal(await execute("process.exit(3)"), 3);
  assert.equal(await alertOf(), "not-needed");
  assert.equal(await execute("process.exit(0)"), 0);
  const recovery = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(recovery.exitCode, 0);
  assert.equal(recovery.timedOut, undefined);
  assert.equal(recovery.alert, "sent");
  assert.equal(await execute("process.exit(0)"), 0);
  assert.equal(await alertOf(), "not-needed");
  assert.deepEqual(
    sent.map(({ subject }) => subject.replace(/^[^:]+: /, "")),
    ["software-update failed with exit code 124", "software-update recovered"],
  );
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
  await writeAlertConfig(home);
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
    runUpdate("software-update", home, "fixture", [], async () => accepted()).pipe(
      Effect.provideService(BoundedCommand, runner),
      Effect.provide(NodeServices.layer),
    ),
  );
  assert.equal(result, 125);
  assert.equal(executions, 1);
});

test("an unwritable initial receipt prevents launch and recovers after storage is repaired", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dotfiles-update-storage-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, ".local/state/dotfiles/updates");
  const obstruction = join(directory, `software-update.json.${process.pid}.tmp`);
  await mkdir(obstruction, { recursive: true });
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
  assert.equal(executions, 0);
  await rm(obstruction, { recursive: true });
  assert.equal(await execute(), 0);
  assert.equal(executions, 1);
});

test("a pre-spawn failure remains retryable without removing the receipt", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dotfiles-update-spawn-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  const execute = (command: string, args: string[]) =>
    Effect.runPromise(
      runUpdate("software-update", home, command, args).pipe(
        Effect.provide(BoundedCommand.layer),
        Effect.provide(CommandRunner.layer),
        Effect.provide(NodeServices.layer),
      ),
    );
  assert.equal(await execute(join(home, "missing-executable"), []), 127);
  const receipt = JSON.parse(
    await readFile(join(home, ".local/state/dotfiles/updates/software-update.json"), "utf8"),
  );
  assert.equal(receipt.cleanupComplete, undefined);
  assert.equal(await execute(process.execPath, ["-e", "process.exit(0)"]), 0);
});

test("a transient initial receipt failure does not leave a cleanup block for an unstarted command", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dotfiles-update-transient-storage-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  let rejectInitialWrite = true;
  let executions = 0;
  const runner = BoundedCommand.of({
    run: () => {
      executions++;
      return Effect.succeed({ status: 0, timedOut: false, cleanupComplete: true });
    },
  });
  const execute = () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* runUpdate("software-update", home, "fixture", []).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            writeFileString: (path, content, options) => {
              if (rejectInitialWrite && path.endsWith(`software-update.json.${process.pid}.tmp`)) {
                rejectInitialWrite = false;
                return fs.writeFileString(home, content, options);
              }
              return fs.writeFileString(path, content, options);
            },
          }),
        );
      }).pipe(Effect.provideService(BoundedCommand, runner), Effect.provide(NodeServices.layer)),
    );
  assert.equal(await execute(), 125);
  assert.equal(executions, 0);
  const receipt = JSON.parse(
    await readFile(join(home, ".local/state/dotfiles/updates/software-update.json"), "utf8"),
  );
  assert.notEqual(receipt.cleanupComplete, false);
  assert.equal(await execute(), 0);
  assert.equal(executions, 1);
});
