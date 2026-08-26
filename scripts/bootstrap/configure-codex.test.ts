#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { managedEdits } from "./configure-codex.ts";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "configure-codex.ts");
const codexInstalled = spawnSync("codex", ["--version"], { stdio: "ignore" }).status === 0;

function run(home: string) {
  return spawnSync(script, { encoding: "utf8", env: { ...process.env, CODEX_HOME: home } });
}

test("Codex defaults are one typed atomic edit batch", () => {
  assert.deepEqual(managedEdits, [
    { keyPath: "forced_login_method", value: null, mergeStrategy: "replace" },
    { keyPath: "model", value: "gpt-5.6-sol", mergeStrategy: "upsert" },
    { keyPath: "model_reasoning_effort", value: "high", mergeStrategy: "upsert" },
    { keyPath: "service_tier", value: "default", mergeStrategy: "upsert" },
    { keyPath: "features.fast_mode", value: false, mergeStrategy: "upsert" },
    { keyPath: "features.goals", value: true, mergeStrategy: "upsert" },
    { keyPath: "features.memories", value: false, mergeStrategy: "upsert" },
  ]);
});

test("installed Codex removes forced login, preserves unrelated config, and is idempotent", { skip: !codexInstalled }, () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-codex-config-"));
  const home = join(root, "codex");
  const config = join(home, "config.toml");
  try {
    mkdirSync(home);
    writeFileSync(config, 'forced_login_method = "chatgpt"\n# keep this comment\napproval_policy = "never"\n\n[mcp_servers.fixture]\ncommand = "example"\n');
    chmodSync(config, 0o644);

    const first = run(home);
    assert.equal(first.status, 0, first.stderr);
    const contents = readFileSync(config, "utf8");
    assert.ok(contents.includes("# keep this comment"));
    assert.ok(contents.includes('approval_policy = "never"'));
    assert.ok(contents.includes('[mcp_servers.fixture]\ncommand = "example"'));
    assert.ok(!contents.includes("forced_login_method"));
    for (const expected of [
      'model = "gpt-5.6-sol"',
      'model_reasoning_effort = "high"', 'service_tier = "default"',
      "fast_mode = false", "goals = true", "memories = false",
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
