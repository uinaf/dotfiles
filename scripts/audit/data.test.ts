#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findingLocators, mergeRuleCounts, sqlitePageStats } from "./data.ts";

function sqliteHeader(pageCount = 2, freelistCount = 1, pageSize = 4096): Buffer {
  const file = Buffer.alloc(pageCount * pageSize);
  file.write("SQLite format 3\0", 0, "binary");
  file.writeUInt16BE(pageSize, 16);
  file.writeUInt32BE(7, 24);
  file.writeUInt32BE(pageCount, 28);
  file.writeUInt32BE(freelistCount, 36);
  file.writeUInt32BE(7, 92);
  file.writeUInt32BE(3_007_000, 96);
  return file;
}

test("SQLite stats validate the header without opening the database", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-audit-data-"));
  try {
    const path = join(root, "logs.sqlite");
    writeFileSync(path, sqliteHeader());
    assert.deepEqual(sqlitePageStats(path), [4096, 2, 1]);
    writeFileSync(path, sqliteHeader(2, 3));
    assert.throws(() => sqlitePageStats(path), /inconsistent SQLite header/);
    writeFileSync(path, sqliteHeader(2, 0, 256));
    assert.throws(() => sqlitePageStats(path), /invalid SQLite page size/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("gitleaks data exposes only safe locators and aggregate counts", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-audit-data-"));
  try {
    const report = join(root, "report.json");
    writeFileSync(
      report,
      JSON.stringify([
        { RuleID: "private-key", File: join(root, "home/.ssh/id"), Secret: "hidden" },
        { RuleID: "token", File: "/outside/path", Match: "hidden" },
        { RuleID: "relative", File: "home/.ssh/id" },
        { RuleID: "empty", File: "" },
      ]),
    );
    assert.deepEqual(findingLocators(root, report), [
      "private-key\thome/.ssh/id",
      "token\tunknown",
      "relative\tunknown",
      "empty\tunknown",
    ]);
    assert.deepEqual(mergeRuleCounts('{"private-key":2}', report), { empty: 1, "private-key": 3, relative: 1, token: 1 });
    assert.throws(() => mergeRuleCounts('{"private-key":-1}', report), /invalid count/);
    assert.throws(() => mergeRuleCounts(`{"private-key":${Number.MAX_SAFE_INTEGER + 1}}`, report), /invalid count/);
    const missingRoot = join(root, "missing");
    writeFileSync(report, JSON.stringify([{ RuleID: "token", File: join(missingRoot, "home/token") }]));
    assert.deepEqual(findingLocators(missingRoot, report), ["token\thome/token"]);
    writeFileSync(report, "not json");
    assert.deepEqual(findingLocators(root, report), []);
    assert.deepEqual(mergeRuleCounts("", report), {});
    const cliPath = join(root, "data.ts");
    symlinkSync(join(import.meta.dirname, "data.ts"), cliPath);
    const cli = spawnSync(process.execPath, [cliPath, "gitleaks-locators", root, report], {
      encoding: "utf8",
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stdout, "");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
