import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bundleGatewayHelpers } from "./bundle.ts";

const bundles = bundleGatewayHelpers();

async function fixture(t: test.TestContext, childSource: string, args?: string[]) {
  const root = await mkdtemp(join(tmpdir(), "gateway-acp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const helper = join(root, "cursor-acp-api-key-auth");
  const child = join(root, "child.cjs");
  await writeFile(helper, (await bundles)["cursor-acp-api-key-auth"], { mode: 0o700 });
  await chmod(helper, 0o700);
  await writeFile(child, childSource);
  const proxy = spawn(helper, args ?? [process.execPath, child], {
    cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root }, stdio: "pipe",
  });
  t.after(() => { if (proxy.exitCode === null && proxy.signalCode === null) proxy.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  proxy.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  proxy.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  proxy.stdin.on("error", () => {});
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timeout = setTimeout(() => { proxy.kill("SIGKILL"); reject(new Error(`ACP did not exit; stderr=${stderr}`)); }, 8_000);
    proxy.once("error", error => { clearTimeout(timeout); reject(error); });
    proxy.once("close", (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
  });
  return { root, process: proxy, closed, stdout: () => stdout, stderr: () => stderr };
}

function waitForStderr(child: ChildProcessWithoutNullStreams, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => { child.stderr.off("data", listen); reject(new Error(`missing child marker ${text}`)); }, 4_000);
    function listen(chunk: string) {
      output += chunk;
      if (!output.includes(text)) return;
      clearTimeout(timeout);
      child.stderr.off("data", listen);
      resolve();
    }
    child.stderr.on("data", listen);
  });
}

test("ACP exits with its child status even while upstream stdin stays open", async t => {
  const f = await fixture(t, "process.exit(23);");
  assert.deepEqual(await f.closed, { code: 23, signal: null });
  assert.equal(f.stdout(), "");
});

test("ACP retains its usage exit status when no child command is supplied", async t => {
  const f = await fixture(t, "", []);
  assert.deepEqual(await f.closed, { code: 2, signal: null });
  assert.equal(f.stdout(), "");
  assert.match(f.stderr(), /usage: cursor-acp-api-key-auth/);
});

test("ACP intercepts authenticate requests, forwards notifications and malformed lines, and drains on EOF", async t => {
  const f = await fixture(t, `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', line => process.stdout.write(line + '\\n'));
  `);
  const forwarded = ['{malformed', '{"method":"authenticate"}', '{"id":11,"method":"session/new"}', '[1,2,3]'];
  f.process.stdin.end([...forwarded, '{"jsonrpc":"2.0","id":1,"method":"authenticate","params":{"methodId":"cursor_login"}}'].join("\n") + "\n");
  assert.deepEqual(await f.closed, { code: 0, signal: null });
  assert.deepEqual(f.stdout().trim().split("\n").sort(), [...forwarded, '{"jsonrpc":"2.0","id":1,"result":{}}'].sort());
});

test("ACP keeps child NDJSON frames intact when authentication arrives between stdout chunks", async t => {
  const f = await fixture(t, `
    process.stdout.write('{"jsonrpc":"2.0","id":99,"res');
    process.stderr.write('partial-ready\\n');
    setTimeout(() => { process.stdout.write('ult":{"value":"kept"}}\\n'); process.exitCode = 0; }, 150);
  `);
  await waitForStderr(f.process, "partial-ready");
  f.process.stdin.write('{"jsonrpc":"2.0","id":1,"method":"authenticate"}\n');
  assert.deepEqual(await f.closed, { code: 0, signal: null });
  const messages = f.stdout().trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(messages.sort((a, b) => a.id - b.id), [
    { jsonrpc: "2.0", id: 1, result: {} },
    { jsonrpc: "2.0", id: 99, result: { value: "kept" } },
  ]);
});

test("ACP preserves complete output before reporting a nonzero child exit", async t => {
  const payload = "x".repeat(200_000);
  const f = await fixture(t, `process.stdout.write(JSON.stringify({result:${JSON.stringify(payload)}}) + '\\n', () => process.exit(7));`);
  assert.deepEqual(await f.closed, { code: 7, signal: null });
  assert.deepEqual(JSON.parse(f.stdout()), { result: payload });
});

test("ACP shutdown signals terminate the owned child", async t => {
  const f = await fixture(t, `
    const fs = require('node:fs');
    process.on('SIGTERM', () => { fs.writeFileSync('terminated', 'yes'); process.exit(0); });
    process.stderr.write('running\\n');
    setTimeout(() => process.exit(0), 15000);
  `);
  await waitForStderr(f.process, "running");
  f.process.kill("SIGTERM");
  const result = await f.closed;
  assert.ok(result.signal === "SIGTERM" || result.code === 143, JSON.stringify(result));
  assert.equal(await readFile(join(f.root, "terminated"), "utf8"), "yes");
});

test("ACP drains authentication replies through a slow downstream before completing", async t => {
  const f = await fixture(t, `
    process.stderr.write('ready\\n');
    process.stdin.resume();
    process.stdin.on('end', () => process.stdout.write('{"id":"child","result":{}}\\n'));
  `);
  f.process.stdout.pause();
  await waitForStderr(f.process, "ready");
  const count = 4_000;
  f.process.stdin.end(Array.from({ length: count }, (_, id) => JSON.stringify({ id, method: "authenticate" })).join("\n") + "\n");
  const resume = setTimeout(() => f.process.stdout.resume(), 100);
  t.after(() => clearTimeout(resume));
  assert.deepEqual(await f.closed, { code: 0, signal: null });
  const messages = f.stdout().trim().split("\n").map(line => JSON.parse(line));
  assert.equal(messages.length, count + 1);
  assert.equal(new Set(messages.map(message => message.id)).size, count + 1);
  assert.ok(messages.every(message => JSON.stringify(message.result) === "{}"));
});

test("ACP drains final frames and preserves status when the child closes stdin early", async t => {
  const f = await fixture(t, `
    require('node:fs').closeSync(0);
    process.stderr.write('input-closed\\n');
    setTimeout(() => process.stdout.write('{"id":17,"result":{"final":true}}\\n', () => process.exit(17)), 200);
  `);
  await waitForStderr(f.process, "input-closed");
  f.process.stdin.write(JSON.stringify({ id: 1, method: "session/new", params: { payload: "x".repeat(200_000) } }) + "\n");
  assert.deepEqual(await f.closed, { code: 17, signal: null });
  assert.deepEqual(JSON.parse(f.stdout()), { id: 17, result: { final: true } });
});
