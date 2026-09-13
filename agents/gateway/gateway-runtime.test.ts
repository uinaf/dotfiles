import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";

const cwd = fileURLToPath(new URL("../..", import.meta.url));

function run(program: string) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { Effect } from "effect";
    import { failure, main } from "./agents/gateway/gateway-runtime.ts";
    ${program}
  `,
    ],
    { cwd, encoding: "utf8", timeout: 10_000 },
  );
}

test("gateway failures preserve their explicit message and status", () => {
  const result = run('main(failure("invalid provider", 2));');
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "FAILED: invalid provider\n");
});

test("gateway defects report failure without exposing their contents", () => {
  const result = run(
    'main(Effect.sync(() => { throw new Error("credential-must-stay-private"); }));',
  );
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "FAILED: gateway adapter failed\n");
  assert.equal(result.stdout, "");
});

test("SIGTERM preserves gateway status and completes finalizers", () => {
  const result = run(`
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 20);
    main(Effect.never.pipe(Effect.ensuring(Effect.sync(() => process.stdout.write("finalized")))));
  `);
  assert.equal(result.status, 143);
  assert.equal(result.stdout, "finalized");
  assert.equal(result.stderr, "");
});
