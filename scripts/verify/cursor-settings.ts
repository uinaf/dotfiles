#!/usr/bin/env node

import assert from "node:assert/strict";
import { Console, Effect } from "effect";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMain } from "../lib/program.ts";
import { runApply } from "./home-fixture.ts";

type CursorSettings = Record<string, unknown> & {
  model?: { displayName?: string; displayNameShort?: string; modelId?: string };
};

function settingsPath(root: string): string {
  return join(root, "home/.cursor/cli-config.json");
}

function writeSettings(root: string, contents: string, mode = 0o600): void {
  const path = settingsPath(root);
  mkdirSync(join(root, "home/.cursor"), { recursive: true });
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
}

async function verifyProfile(root: string, profile: string, expectedName: string): Promise<void> {
  const fixtureRoot = join(root, profile);
  const path = settingsPath(fixtureRoot);
  writeSettings(fixtureRoot, '{"version":1,"notifications":false}\n', 0o644);
  await runApply(profile, fixtureRoot);
  const firstContents = readFileSync(path, "utf8");
  const settings = JSON.parse(firstContents) as CursorSettings;
  assert.equal(settings.version, 1);
  assert.equal(settings.notifications, false);
  assert.equal(settings.model?.modelId, "grok-4.6");
  assert.equal(settings.model?.displayName, expectedName);
  assert.equal(settings.model?.displayNameShort, expectedName);
  assert.equal(settings.maxMode, false);
  assert.equal(settings.hasChangedDefaultModel, true);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  await runApply(profile, fixtureRoot);
  assert.equal(readFileSync(path, "utf8"), firstContents);
}

async function verifyMalformed(root: string): Promise<void> {
  const fixtureRoot = join(root, "malformed");
  const original = '{"model":';
  writeSettings(fixtureRoot, original);
  await assert.rejects(runApply("workstation", fixtureRoot), /fromJson|invalid character|unexpected end/i);
  assert.equal(readFileSync(settingsPath(fixtureRoot), "utf8"), original);
}

async function verifyAssistantExcluded(root: string): Promise<void> {
  const fixtureRoot = join(root, "assistant");
  await runApply("assistant", fixtureRoot);
  assert.equal(existsSync(settingsPath(fixtureRoot)), false);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-cursor-settings-"));
  try {
    const results = await Promise.allSettled([
      verifyProfile(root, "personal-workstation", "Cursor Grok 4.6 High Fast"),
      verifyProfile(root, "personal-devbox", "Cursor Grok 4.6 High Fast"),
      verifyProfile(root, "workstation", "Cursor Grok 4.6"),
      verifyProfile(root, "devbox", "Cursor Grok 4.6"),
      verifyMalformed(root),
      verifyAssistantExcluded(root),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

runMain(Effect.tryPromise({ try: main, catch: (error) => error }).pipe(
  Effect.tap(() => Console.log("ok Cursor user settings preserve unrelated state and select profile-aware Grok defaults")),
));
