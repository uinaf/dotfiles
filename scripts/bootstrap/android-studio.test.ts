import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { parseCaskInfo, pickInstallTarget, satisfiesPin } from "./android-studio.ts";

const info = (version: string, installed?: string) => JSON.stringify({
  casks: [{ token: "android-studio", version, ...(installed ? { installed } : { installed: null }) }],
});

test("brew cask info keeps the stable token and strips the codename", () => {
  const cask = parseCaskInfo(info("2026.1.4.7,quail4", "2026.1.4.7,quail4"));
  assert.deepEqual(cask, {
    token: "android-studio",
    version: "2026.1.4.7,quail4",
    installed: "2026.1.4.7,quail4",
  });
  assert.equal(parseCaskInfo(JSON.stringify({ casks: [{ token: "android-studio-preview", version: "2026.2.1.1" }] })), undefined);
});

test("the declared pin matches only the numbered stable cask", () => {
  assert.equal(satisfiesPin("2026.1.4.7,quail4", "2026.1.4.7"), true);
  assert.equal(satisfiesPin("2026.1.4.7", "2026.1.4.7"), true);
  assert.equal(satisfiesPin("2026.1.5.1,quail5", "2026.1.4.7"), false);
  assert.equal(satisfiesPin("2026.1.4.7-rc1", "2026.1.4.7"), false);
  assert.equal(satisfiesPin("2026.2.1.1 canary", "2026.1.4.7"), false);
  assert.equal(satisfiesPin("2026.1.4.7 Beta", "2026.1.4.7"), false);
  assert.equal(pickInstallTarget(parseCaskInfo(info("2026.1.4.7,quail4")), "2026.1.4.7")?.version, "2026.1.4.7,quail4");
  assert.equal(pickInstallTarget(parseCaskInfo(info("2026.1.5.1,quail5")), "2026.1.4.7"), undefined);
});

test("check fails when the installed cask is behind the pin", t => {
  const home = mkdtempSync(join(tmpdir(), "android-studio-check."));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(home, "android-studio.json"), `${JSON.stringify({ version: 1, release: "2026.1.5.1" })}\n`);
  writeFileSync(join(home, "cask.json"), `${info("2026.1.5.1,quail5", "2026.1.4.7,quail4")}\n`);
  writeFileSync(join(bin, "brew"), `#!/bin/sh\nif [ "$1" = info ]; then cat "$HOME/cask.json"; exit 0; fi\nexit 1\n`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "android-studio.ts"), "--check"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      DOTFILES_ANDROID_STUDIO_FILE: join(home, "android-studio.json"),
    },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /installed Android Studio is 2026\.1\.4\.7; pin is 2026\.1\.5\.1/);
});

test("check passes when the installed cask is the pinned stable release", t => {
  const home = mkdtempSync(join(tmpdir(), "android-studio-ok."));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(home, "android-studio.json"), `${JSON.stringify({ version: 1, release: "2026.1.4.7" })}\n`);
  writeFileSync(join(home, "cask.json"), `${info("2026.1.4.7,quail4", "2026.1.4.7,quail4")}\n`);
  writeFileSync(join(bin, "brew"), `#!/bin/sh\nif [ "$1" = info ]; then cat "$HOME/cask.json"; exit 0; fi\nexit 1\n`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "android-studio.ts"), "--check"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      DOTFILES_ANDROID_STUDIO_FILE: join(home, "android-studio.json"),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Android Studio 2026\.1\.4\.7 matches pin 2026\.1\.4\.7/);
});
