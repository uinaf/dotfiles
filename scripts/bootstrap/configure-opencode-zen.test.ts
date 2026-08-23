import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";

const script = resolve(import.meta.dirname, "configure-opencode-zen.ts");

test("configures and checks OpenCode Zen without replacing other providers", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-opencode-zen-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const payload = join(root, "identity.sops.json");
  const config = join(home, ".config/dotfiles/llm-gateway.json");
  const auth = join(home, ".local/share/opencode/auth.json");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, ".config/dotfiles"), { recursive: true });
  mkdirSync(join(home, ".local/share/opencode"), { recursive: true });
  writeFileSync(payload, "ciphertext\n");
  writeFileSync(config, `${JSON.stringify({ secretFile: payload })}\n`, { mode: 0o600 });
  writeFileSync(auth, `${JSON.stringify({ anthropic: { type: "api", key: "kept" } })}\n`, { mode: 0o644 });
  writeFileSync(join(bin, "sops"), `#!/bin/sh
if [ "$1" = filestatus ]; then
  printf '{"encrypted":true}\\n'
else
  printf '{"OPENCODE_ZEN_API_KEY":"zen_test_key_1234567890"}\\n'
fi
`, { mode: 0o700 });
  chmodSync(join(bin, "sops"), 0o700);

  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` };
  execFileSync(script, { env });
  execFileSync(script, ["--check"], { env });

  const result = JSON.parse(readFileSync(auth, "utf8"));
  assert.deepEqual(result.anthropic, { type: "api", key: "kept" });
  assert.deepEqual(result.opencode, { type: "api", key: "zen_test_key_1234567890" });
  assert.equal(statSync(auth).mode & 0o777, 0o600);
});
