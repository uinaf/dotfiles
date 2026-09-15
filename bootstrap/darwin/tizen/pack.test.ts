import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

test("Tizen packing publishes private archives and preserves existing outputs", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-tizen-pack-"));
  try {
    const home = join(root, "home");
    mkdirSync(join(home, "SamsungCertificate"), { recursive: true });
    writeFileSync(join(home, "SamsungCertificate", "fixture.txt"), "fixture certificate");
    const output = join(root, "backup.tar.gz");
    const pack = () =>
      spawnSync(
        "/bin/sh",
        [
          "-c",
          'umask 022; exec "$@"',
          "tizen-pack",
          process.execPath,
          join(import.meta.dirname, "pack.ts"),
          output,
        ],
        {
          env: { ...process.env, HOME: home },
          encoding: "utf8",
        },
      );
    const result = pack();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    const content = spawnSync("tar", ["-xOzf", output, "SamsungCertificate/fixture.txt"], {
      encoding: "utf8",
    });
    assert.equal(content.status, 0, content.stderr);
    assert.equal(content.stdout, "fixture certificate");
    const original = readFileSync(output);
    assert.notEqual(pack().status, 0);
    assert.deepEqual(readFileSync(output), original);
    rmSync(output);
    const target = join(root, "existing.txt");
    writeFileSync(target, "retain me");
    symlinkSync(target, output);
    assert.notEqual(pack().status, 0);
    assert.equal(readFileSync(target, "utf8"), "retain me");
    assert.equal(
      readdirSync(root).some((name) => name.startsWith(".tizen-pack.")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Tizen packing does not publish a partial archive after tar fails", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-tizen-pack-"));
  try {
    const home = join(root, "home");
    const bin = join(root, "bin");
    mkdirSync(join(home, "SamsungCertificate"), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(bin, "tar"), '#!/bin/sh\nprintf partial > "$4"\nexit 1\n', { mode: 0o700 });
    const output = join(root, "backup.tar.gz");
    const result = spawnSync(process.execPath, [join(import.meta.dirname, "pack.ts"), output], {
      env: { ...process.env, HOME: home, PATH: bin },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(output), false);
    assert.equal(
      readdirSync(root).some((name) => name.startsWith(".tizen-pack.")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
