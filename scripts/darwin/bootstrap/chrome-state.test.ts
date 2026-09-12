#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";

import { updateChromeStateEffect } from "./chrome-state.ts";

function updateChromeState(path: string, mode: "enable" | "disable", flagName: string, flagValue: string): Promise<void> {
  return Effect.runPromise(
    updateChromeStateEffect(path, mode, flagName, flagValue).pipe(Effect.provide(NodeServices.layer)),
  );
}

test("Chrome state updates one flag and preserves unrelated data", async () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-chrome-state-"));
  try {
    const path = join(root, "Chrome/Local State");
    mkdirSync(join(root, "Chrome"));
    writeFileSync(path, JSON.stringify({ browser: { enabled_labs_experiments: ["other@2", "vertical-tabs@0"] }, keep: "dünya" }));
    chmodSync(path, 0o640);
    await updateChromeState(path, "enable", "vertical-tabs", "vertical-tabs@1");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      browser: { enabled_labs_experiments: ["other@2", "vertical-tabs@1"] },
      keep: "dünya",
    });
    assert.equal(statSync(path).mode & 0o777, 0o640);
    await updateChromeState(path, "disable", "vertical-tabs", "vertical-tabs@1");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).browser.enabled_labs_experiments, ["other@2"]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Chrome state creates safely and rejects malformed input without overwrite", async () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-chrome-state-"));
  try {
    const path = join(root, "Chrome/Local State");
    await updateChromeState(path, "enable", "vertical-tabs", "vertical-tabs@1");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    writeFileSync(path, "not json\n");
    await assert.rejects(updateChromeState(path, "enable", "vertical-tabs", "vertical-tabs@1"));
    assert.equal(readFileSync(path, "utf8"), "not json\n");
    writeFileSync(path, '{"browser":{"enabled_labs_experiments":{}}}\n');
    await assert.rejects(
      updateChromeState(path, "enable", "vertical-tabs", "vertical-tabs@1"),
      /must be a JSON array/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Chrome state CLI runs through a symlinked path", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-chrome-state-"));
  try {
    const cliPath = join(root, "chrome-state.ts");
    const statePath = join(root, "Local State");
    symlinkSync(join(import.meta.dirname, "chrome-state.ts"), cliPath);
    const result = spawnSync(process.execPath, [cliPath, statePath, "enable", "vertical-tabs", "vertical-tabs@1"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")).browser.enabled_labs_experiments, ["vertical-tabs@1"]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
