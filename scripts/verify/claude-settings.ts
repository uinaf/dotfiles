#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runApply } from "./home-fixture.ts";

type Settings = Record<string, unknown> & { env?: Record<string, unknown> };
type Fixture = {
  contents: string;
  expected?: Settings;
  malformed?: boolean;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceDir = join(repoRoot, "chezmoi");
const templatePath = join(sourceDir, "private_dot_claude/modify_private_settings.json");
const managedKey = "CLAUDE_CODE_DISABLE_1M_CONTEXT";
const fixtures: Fixture[] = [
  { contents: "", expected: {} },
  { contents: '{"theme":"dark","cleanupPeriodDays":30}', expected: { theme: "dark", cleanupPeriodDays: 30 } },
  {
    contents: '{"env":{"KEEP":"yes"},"permissions":{"allow":["Read"]}}',
    expected: { env: { KEEP: "yes" }, permissions: { allow: ["Read"] } },
  },
  { contents: '{"env":{"CLAUDE_CODE_DISABLE_1M_CONTEXT":"1"}}', expected: {} },
  {
    contents: '{\n    "theme": "dark",\n    "env": {\n        "KEEP": "yes"\n    }\n}\n',
    expected: { theme: "dark", env: { KEEP: "yes" } },
  },
  { contents: '{"env":', malformed: true },
];

function settingsPath(root: string): string {
  return join(root, "home/.claude/settings.json");
}

function writeSettings(root: string, contents: string, mode = 0o600): void {
  const path = settingsPath(root);
  mkdirSync(join(root, "home/.claude"), { recursive: true });
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
}

function renderFixture(fixture: Fixture): Promise<void> {
  return new Promise((finish, reject) => {
    const child = spawn("chezmoi", [
      "--source",
      sourceDir,
      "--override-data",
      '{"dotfilesProfile":"workstation"}',
      "execute-template",
      "--with-stdin",
      "--file",
      templatePath,
    ], { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      const error = Buffer.concat(stderr).toString();
      try {
        if (fixture.malformed) {
          assert.notEqual(status, 0);
          assert.match(error, /fromJson|invalid character|unexpected end/i);
          finish();
          return;
        }
        assert.equal(status, 0, error);
        const actual = JSON.parse(Buffer.concat(stdout).toString()) as Settings;
        const expected = fixture.expected ?? {};
        assert.deepEqual(
          { ...actual, env: { ...actual.env, [managedKey]: undefined } },
          { ...expected, env: { ...expected.env, [managedKey]: undefined } },
        );
        assert.equal(actual.env?.[managedKey], "1");
        finish();
      } catch (failure) {
        reject(failure);
      }
    });
    child.stdin.end(fixture.contents);
  });
}

async function verifyMissingFile(root: string): Promise<void> {
  const fixtureRoot = join(root, "missing");
  await runApply("workstation", fixtureRoot);
  const path = settingsPath(fixtureRoot);
  assert.equal((JSON.parse(readFileSync(path, "utf8")) as Settings).env?.[managedKey], "1");
  assert.equal(Number(statSync(path, { bigint: true }).mode & 0o777n), 0o600);
}

async function verifyMalformedFile(root: string): Promise<void> {
  const fixtureRoot = join(root, "malformed");
  const original = '{"env":';
  writeSettings(fixtureRoot, original);
  await assert.rejects(runApply("workstation", fixtureRoot), /fromJson|invalid character|unexpected end/i);
  assert.equal(readFileSync(settingsPath(fixtureRoot), "utf8"), original);
}

async function verifyModeAndIdempotence(root: string): Promise<void> {
  const fixtureRoot = join(root, "wrong-mode");
  const path = settingsPath(fixtureRoot);
  writeSettings(fixtureRoot, '{"theme":"light"}\n', 0o644);
  await runApply("workstation", fixtureRoot);
  const firstContents = readFileSync(path, "utf8");
  const firstMtime = statSync(path, { bigint: true }).mtimeNs;
  assert.equal((JSON.parse(firstContents) as Settings).env?.[managedKey], "1");
  assert.equal(Number(statSync(path, { bigint: true }).mode & 0o777n), 0o600);
  await runApply("workstation", fixtureRoot);
  assert.equal(readFileSync(path, "utf8"), firstContents);
  assert.equal(statSync(path, { bigint: true }).mtimeNs, firstMtime);
}

async function verifyExcludedProfile(root: string, profile: "assistant" | "service", contents?: string): Promise<void> {
  const fixtureRoot = join(root, profile);
  if (contents !== undefined) {
    writeSettings(fixtureRoot, contents, 0o644);
  }
  await runApply(profile, fixtureRoot);
  const path = settingsPath(fixtureRoot);
  if (contents === undefined) {
    assert.equal(existsSync(path), false);
  } else {
    assert.equal(readFileSync(path, "utf8"), contents);
    assert.equal(Number(statSync(path, { bigint: true }).mode & 0o777n), 0o644);
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-claude-settings-"));
  try {
    const results = await Promise.allSettled([
      ...fixtures.map(renderFixture),
      verifyMissingFile(root),
      verifyMalformedFile(root),
      verifyModeAndIdempotence(root),
      verifyExcludedProfile(root, "assistant", '{"env":{"KEEP":"yes"}}\n'),
      verifyExcludedProfile(root, "service"),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      throw failure.reason;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  await main();
  process.stdout.write("ok Claude user settings preserve unrelated state\n");
} catch (error) {
  process.stderr.write(`FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
