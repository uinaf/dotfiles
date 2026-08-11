#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "configure-codex.ts");
const defaults = JSON.parse(readFileSync(resolve(dirname(script), "codex-defaults.json"))) as {
  version?: unknown;
  values?: Record<string, unknown>;
};
const codexInstalled = spawnSync("codex", ["--version"], { stdio: "ignore" }).status === 0;

function run(home: string) {
  return spawnSync(script, { encoding: "utf8", env: { ...process.env, CODEX_HOME: home } });
}

test("Codex defaults use the supported scalar schema", () => {
  assert.equal(defaults.version, 1);
  assert.ok(defaults.values);
  assert.equal(defaults.values.forced_login_method, "chatgpt");
  assert.equal(defaults.values["features.fast_mode"], false);
  for (const [key, value] of Object.entries(defaults.values)) {
    assert.match(key, /^[A-Za-z0-9_.-]+$/);
    assert.ok(["boolean", "number", "string"].includes(typeof value));
  }
});

test("installed Codex uses the native atomic writer and preserves local config", { skip: !codexInstalled }, () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-codex-config-"));
  const home = join(root, "codex");
  const config = join(home, "config.toml");
  try {
    mkdirSync(home);
    writeFileSync(config, '# keep this comment\napproval_policy = "never"\n\n[mcp_servers.fixture]\ncommand = "example"\n');
    chmodSync(config, 0o644);

    const first = run(home);
    assert.equal(first.status, 0, first.stderr);
    const contents = readFileSync(config, "utf8");
    assert.ok(contents.includes("# keep this comment"));
    assert.ok(contents.includes('[mcp_servers.fixture]\ncommand = "example"'));
    for (const expected of [
      'forced_login_method = "chatgpt"', 'model = "gpt-5.6-sol"',
      'model_reasoning_effort = "medium"', 'service_tier = "default"',
      "fast_mode = false", "goals = true", "memories = true",
    ]) assert.ok(contents.includes(expected), `missing ${expected}`);
    assert.equal(statSync(config).mode & 0o777, 0o600);

    const second = run(home);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(config, "utf8"), contents);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed Codex does not overwrite malformed input", { skip: !codexInstalled }, () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-codex-config-invalid-"));
  const home = join(root, "codex");
  const config = join(home, "config.toml");
  try {
    mkdirSync(home);
    writeFileSync(config, "model = [\n");
    const result = run(home);
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(config, "utf8"), "model = [\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
