#!/usr/bin/env node

import assert from "node:assert/strict";
import { Console, Effect } from "effect";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runMain } from "../lib/program.ts";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runApply } from "./home-fixture.ts";

type Settings = Record<string, unknown> & {
  autoMemoryEnabled?: boolean;
  env?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
};
type Fixture = {
  contents: string;
  expected?: Settings;
  malformed?: boolean;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceDir = join(repoRoot, "chezmoi");
const templatePath = join(sourceDir, "private_dot_claude/modify_private_settings.json");
const managedMode = "defaultMode";
const fixtures: Fixture[] = [
  { contents: "", expected: {} },
  { contents: '{"theme":"dark","cleanupPeriodDays":30}', expected: { theme: "dark", cleanupPeriodDays: 30 } },
  {
    contents: '{"env":{"KEEP":"yes"},"permissions":{"allow":["Read"]}}',
    expected: { env: { KEEP: "yes" }, permissions: { allow: ["Read"] } },
  },
  {
    contents: '{"env":{"CLAUDE_CODE_DISABLE_1M_CONTEXT":"1"}}',
    expected: { env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" } },
  },
  {
    contents: '{"env":{"CLAUDE_CODE_DISABLE_1M_CONTEXT":"1","KEEP":"yes"}}',
    expected: { env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1", KEEP: "yes" } },
  },
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

function renderFixture(fixture: Fixture, root: string): Promise<void> {
  return new Promise((finish, reject) => {
    const home = join(root, "home");
    const temp = join(root, "tmp");
    const agentRulesPath = join(root, "xdg/state/dotfiles/agent-rules.md");
    mkdirSync(home, { recursive: true });
    mkdirSync(temp, { recursive: true });
    mkdirSync(dirname(agentRulesPath), { recursive: true });
    writeFileSync(agentRulesPath, "## General guidelines\n\nFixture shared rule.\n", { mode: 0o600 });
    const child = spawn("chezmoi", [
      "--source",
      sourceDir,
      "--override-data",
      JSON.stringify({ agentRulesPath, dotfilesProfile: "workstation" }),
      "execute-template",
      "--with-stdin",
      "--file",
      templatePath,
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(root, "xdg/config"),
        XDG_CACHE_HOME: join(root, "xdg/cache"),
        XDG_DATA_HOME: join(root, "xdg/data"),
        XDG_STATE_HOME: join(root, "xdg/state"),
        TMPDIR: temp,
        GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
        GIT_CONFIG_NOSYSTEM: "1",
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
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
          {
            ...actual,
            model: undefined,
            effortLevel: undefined,
            outputStyle: undefined,
            attribution: undefined,
            permissions: { ...actual.permissions, [managedMode]: undefined },
          },
          {
            ...expected,
            model: undefined,
            effortLevel: undefined,
            outputStyle: undefined,
            attribution: undefined,
            autoMemoryEnabled: false,
            permissions: { ...expected.permissions, [managedMode]: undefined },
          },
        );
        assert.equal(actual.model, "claude-fable-5");
        assert.equal(actual.effortLevel, "medium");
        assert.equal(actual.outputStyle, "Concise");
        assert.equal(actual.autoMemoryEnabled, false);
        assert.deepEqual(actual.attribution, { commit: "", pr: "", sessionUrl: false });
        assert.equal(actual.permissions?.[managedMode], "auto");
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
  const written = JSON.parse(readFileSync(path, "utf8")) as Settings;
  assert.equal(written.autoMemoryEnabled, false);
  assert.equal(written.permissions?.[managedMode], "auto");
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
  assert.equal((JSON.parse(firstContents) as Settings).autoMemoryEnabled, false);
  assert.equal((JSON.parse(firstContents) as Settings).model, "claude-fable-5");
  assert.equal((JSON.parse(firstContents) as Settings).effortLevel, "medium");
  assert.equal((JSON.parse(firstContents) as Settings).outputStyle, "Concise");
  assert.equal((JSON.parse(firstContents) as Settings).permissions?.[managedMode], "auto");
  assert.equal(Number(statSync(path, { bigint: true }).mode & 0o777n), 0o600);
  await runApply("workstation", fixtureRoot);
  assert.equal(readFileSync(path, "utf8"), firstContents);
  assert.equal(statSync(path, { bigint: true }).mtimeNs, firstMtime);
}

async function verifyExcludedProfile(root: string, profile: "assistant", contents?: string): Promise<void> {
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
      ...fixtures.map((fixture) => renderFixture(fixture, join(root, "render"))),
      verifyMissingFile(root),
      verifyMalformedFile(root),
      verifyModeAndIdempotence(root),
      verifyExcludedProfile(root, "assistant", '{"env":{"KEEP":"yes"}}\n'),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      throw failure.reason;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

runMain(Effect.tryPromise({ try: main, catch: (error) => error }).pipe(
  Effect.tap(() => Console.log("ok Claude user settings preserve unrelated state")),
));
