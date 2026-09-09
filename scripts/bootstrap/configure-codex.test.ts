#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "configure-codex.ts");
const codexInstalled = spawnSync("codex", ["--version"], { stdio: "ignore" }).status === 0;

function run(home: string, profile = "workstation") {
  return spawnSync(script, ["--profile", profile], { encoding: "utf8", env: { ...process.env, CODEX_HOME: home } });
}

function assertDefaults(contents: string): void {
  const root = contents.split(/^\[/m)[0];
  const features = contents.split(/^\[features\][ \t]*$/m)[1]?.split(/^\[/m)[0];
  assert.ok(features, "native config writer must create the features table");
  assert.match(root, /^model = "gpt-6-astra"$/m);
  assert.match(root, /^model_reasoning_effort = "medium"$/m);
  assert.doesNotMatch(root, /^forced_login_method\s*=/m);
  assert.match(features, /^goals = true$/m);
  assert.match(features, /^memories = false$/m);
  // Fast mode is cleared on every profile: its 2x rate buys output speed that
  // a cached-input-dominated agent session cannot use.
  assert.doesNotMatch(root, /^service_tier\s*=/m);
  assert.doesNotMatch(features, /^fast_mode\s*=/m);
  assert.match(contents, /^\[features\.context_management\]$/m);
  assert.match(contents.split(/^\[features\.context_management\][ \t]*$/m)[1].split(/^\[/m)[0], /^experimental_mode = true$/m);
  assert.match(contents.split(/^\[agents\][ \t]*$/m)[1].split(/^\[/m)[0], /^default_subagent_reasoning_effort = "low"$/m);
}

test("installed Codex removes forced login, preserves unrelated config, and is idempotent", { skip: !codexInstalled }, () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-codex-config-"));
  const home = join(root, "codex");
  const config = join(home, "config.toml");
  try {
    mkdirSync(home);
    writeFileSync(config, 'forced_login_method = "chatgpt"\nservice_tier = "default"\n# keep this comment\napproval_policy = "never"\n\n[features]\nfast_mode = false\n\n[mcp_servers.fixture]\ncommand = "example"\n');
    chmodSync(config, 0o644);

    const first = run(home);
    assert.equal(first.status, 0, first.stderr);
    const contents = readFileSync(config, "utf8");
    assert.ok(contents.includes("# keep this comment"));
    assert.ok(contents.includes('approval_policy = "never"'));
    assert.ok(contents.includes('[mcp_servers.fixture]\ncommand = "example"'));
    assertDefaults(contents);
    assert.equal(statSync(config).mode & 0o777, 0o600);

    const second = run(home);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(config, "utf8"), contents);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed Codex clears Fast mode on personal profiles too", { skip: !codexInstalled }, () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-codex-personal-config-"));
  const home = join(root, "codex");
  const config = join(home, "config.toml");
  try {
    mkdirSync(home);
    writeFileSync(config, 'service_tier = "fast"\n\n[features]\nfast_mode = true\n');
    const result = run(home, "personal-workstation");
    assert.equal(result.status, 0, result.stderr);
    assertDefaults(readFileSync(config, "utf8"));
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
