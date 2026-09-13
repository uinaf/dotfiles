import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { parseCatalog, pickInstallTarget, satisfiesPin } from "./xcode.ts";

const installed = `26.6 (17F113) [Apple Silicon] (Selected)\t/Applications/Xcode-26.6.0.app
`;
const catalog = `
26.6 (17F113) [Apple Silicon] (Installed, Selected)
27.0 Beta 6 (27A5252f) [Apple Silicon]
27.0 Release Candidate (27A266a) [Apple Silicon]
`;

test("installed selected Xcode is parsed from xcodes output", () => {
  const [release] = parseCatalog(installed);
  assert.deepEqual(release, {
    version: "26.6",
    build: "17F113",
    selected: true,
    installed: true,
    path: "/Applications/Xcode-26.6.0.app",
  });
});

test("the declared pin matches only the numbered stable release", () => {
  assert.equal(satisfiesPin("26.6", "26.6"), true);
  assert.equal(satisfiesPin("27.0", "27.0"), true);
  assert.equal(satisfiesPin("27.0 Release Candidate", "27.0"), false);
  assert.equal(satisfiesPin("27.0 GM", "27.0"), false);
  assert.equal(satisfiesPin("27.0 Beta 6", "27.0"), false);
  assert.equal(satisfiesPin("26.6", "27.0"), false);
  assert.equal(pickInstallTarget(parseCatalog(catalog), "26.6")?.version, "26.6");
  assert.equal(pickInstallTarget(parseCatalog(catalog), "27.0"), undefined);
  assert.equal(
    pickInstallTarget(parseCatalog(`${catalog}27.0 (27A300) [Apple Silicon]\n`), "27.0")?.version,
    "27.0",
  );
});

test("check fails when the selected Xcode is behind the pin", t => {
  const home = mkdtempSync(join(tmpdir(), "xcode-check."));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(home, "xcode.json"), `${JSON.stringify({ version: 1, release: "27.0" })}\n`);
  writeFileSync(join(home, "installed.txt"), installed);
  writeFileSync(join(bin, "xcodes"), `#!/bin/sh\nif [ "$1" = installed ]; then cat "$HOME/installed.txt"; exit 0; fi\nexit 1\n`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "xcode.ts"), "--check"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, DOTFILES_XCODE_FILE: join(home, "xcode.json") },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /selected Xcode is 26\.6 \(17F113\); pin is 27\.0/);
});

test("check passes when the selected Xcode is the pinned stable release", t => {
  const home = mkdtempSync(join(tmpdir(), "xcode-ok."));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(home, "xcode.json"), `${JSON.stringify({ version: 1, release: "26.6" })}\n`);
  writeFileSync(join(home, "installed.txt"), installed);
  writeFileSync(join(bin, "xcodes"), `#!/bin/sh\nif [ "$1" = installed ]; then cat "$HOME/installed.txt"; exit 0; fi\nexit 1\n`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "xcode.ts"), "--check"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, DOTFILES_XCODE_FILE: join(home, "xcode.json") },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Xcode 26\.6 \(17F113\) matches pin 26\.6/);
});
