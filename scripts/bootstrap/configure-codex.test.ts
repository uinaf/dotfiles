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

function run(home: string, profile = "workstation") {
  return spawnSync(script, ["--profile", profile], { encoding: "utf8", env: { ...process.env, CODEX_HOME: home } });
}

function assertAppliedEdits(contents: string, personal: boolean): void {
  for (const edit of managedEdits(personal)) {
    const key = edit.keyPath.split(".").at(-1) as string;
    if (edit.value === null) {
      assert.ok(!contents.includes(key), `unexpected ${key}`);
    } else {
      assert.ok(contents.includes(`${key} = ${JSON.stringify(edit.value)}`), `missing ${key}`);
    }
  }
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
    assertAppliedEdits(contents, false);
    assert.equal(statSync(config).mode & 0o777, 0o600);

    const second = run(home);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(config, "utf8"), contents);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed Codex enables Fast mode for personal profiles", { skip: !codexInstalled }, () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-codex-personal-config-"));
  const home = join(root, "codex");
  const config = join(home, "config.toml");
  try {
    mkdirSync(home);
    writeFileSync(config, 'service_tier = "default"\n\n[features]\nfast_mode = false\n');
    const result = run(home, "personal-workstation");
    assert.equal(result.status, 0, result.stderr);
    assertAppliedEdits(readFileSync(config, "utf8"), true);
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
