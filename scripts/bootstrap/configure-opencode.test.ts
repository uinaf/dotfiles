import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";

const script = resolve(import.meta.dirname, "configure-opencode.ts");

test("configures and checks OpenCode without replacing other providers", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-opencode-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const helper = join(bin, "credential-helper");
  const auth = join(home, ".local/share/opencode/auth.json");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, ".local/share/opencode"), { recursive: true });
  writeFileSync(auth, `${JSON.stringify({ anthropic: { type: "api", key: "kept" } })}\n`, { mode: 0o644 });
  writeFileSync(helper, `#!/bin/sh
[ "$1" = opencode ] || exit 2
printf 'opencode_test_key_1234567890\\n'
`, { mode: 0o700 });
  chmodSync(helper, 0o700);

  const env = { ...process.env, HOME: home, OPENCODE_CREDENTIAL_HELPER: helper };
  execFileSync(script, { env });
  execFileSync(script, ["--check"], { env });

  const result = JSON.parse(readFileSync(auth, "utf8"));
  assert.deepEqual(result.anthropic, { type: "api", key: "kept" });
  assert.deepEqual(result.opencode, { type: "api", key: "opencode_test_key_1234567890" });
  assert.deepEqual(result["opencode-go"], { type: "api", key: "opencode_test_key_1234567890" });
  assert.equal(statSync(auth).mode & 0o777, 0o600);
});

test("check fails when the Go catalog slot is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-opencode-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const helper = join(bin, "credential-helper");
  const auth = join(home, ".local/share/opencode/auth.json");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, ".local/share/opencode"), { recursive: true });
  writeFileSync(
    auth,
    `${JSON.stringify({ opencode: { type: "api", key: "opencode_test_key_1234567890" } })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(helper, `#!/bin/sh
[ "$1" = opencode ] || exit 2
printf 'opencode_test_key_1234567890\\n'
`, { mode: 0o700 });
  chmodSync(helper, 0o700);

  const env = { ...process.env, HOME: home, OPENCODE_CREDENTIAL_HELPER: helper };
  assert.throws(
    () => execFileSync(script, ["--check"], { env, encoding: "utf8" }),
    (error: NodeJS.ErrnoException & { stderr?: string }) =>
      /OpenCode authentication drifted/.test(`${error.message}\n${error.stderr ?? ""}`),
  );
});
