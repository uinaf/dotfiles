import assert from "node:assert/strict";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CommandRunner } from "../lib/command.ts";
import { runChecks } from "./run.ts";

test("verification reports completed checks before a stalled child and cleans it up", async () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-runner-"));
  const pidFile = join(root, "pid");
  const errorWrite = process.stderr.write;
  const output: string[] = [];
  let failedBeforeTermination = false;
  process.stderr.write = function(chunk: string | Uint8Array) {
    const text = String(chunk);
    output.push(text);
    if (text.includes("FAILED: quick")) {
      if (existsSync(pidFile)) {
        try {
          process.kill(Number(readFileSync(pidFile, "utf8")), 0);
          failedBeforeTermination = true;
        } catch {
          failedBeforeTermination = false;
        }
      }
    }
    return true;
  };
  try {
    const started = Date.now();
    const result = await Effect.runPromise(runChecks([
      { id: "quick", domain: "static", command: [process.execPath, "-e", "setTimeout(() => process.exit(7), 200)"], output: "failure" },
      { id: "success", domain: "static", command: [process.execPath, "-e", ""], output: "success" },
      { id: "stalled", domain: "static", command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdout.write('progress before stall\\n'); process.stderr.write('warning before stall\\n'); setInterval(() => {}, 1000)`], output: "timeout" },
    ], 1500).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer)));
    assert.equal(result, false);
    assert.equal(failedBeforeTermination, true);
    assert.ok(output.join("").indexOf("FAILED: quick") < output.join("").indexOf("FAILED: stalled"));
    assert.match(output.join(""), /progress before stall\n/);
    assert.match(output.join(""), /warning before stall\n/);
    assert.match(output.join(""), /timed out after 1500ms/);
    assert.ok(Date.now() - started < 7000);
    assert.ok(existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    process.stderr.write = errorWrite;
    rmSync(root, { recursive: true, force: true });
  }
});
