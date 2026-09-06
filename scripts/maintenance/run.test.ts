import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { CommandRunner, CommandError } from "../lib/command.ts";
import { runUpdate } from "./run.ts";

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
    assert.equal(JSON.parse(receipt).heartbeat, scenario === "delivery" || scenario === "invalid" ? "failed"
      : scenario === "unconfigured" ? "not-configured" : "sent");
    const attempt = `${url}${expected ? "/fail" : ""}`;
    assert.deepEqual(sent, scenario === "invalid" || scenario === "unconfigured" ? []
      : scenario === "delivery" || scenario === "retried" ? [attempt, attempt] : [attempt]);
    assert.equal(waits, rejections > 0 ? 1 : 0, "exactly one bounded retry after a failed delivery");
  });
}
