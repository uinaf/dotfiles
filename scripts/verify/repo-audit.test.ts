#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const audit = join(repoRoot, "scripts/audit/repo.sh");
const branches = new Map([
  ["10.15.7", "catalina"],
  ["11.7.10", "big_sur"],
  ["12.7.6", "monterey"],
  ["13.7.8", "ventura"],
  ["14.7.7", "sonoma"],
  ["15.7.3", "sequoia"],
  ["26.6", "tahoe"],
]);

function executable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

test("repo audit maps named mSCP releases and warns on future macOS", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-repo-audit-"));
  const bin = join(root, "bin");
  const mscp = join(root, "macos_security");
  const compliance = join(root, "compliance.sh");
  const run = (version: string, branch: string, json = false) => spawnSync(audit, [
    "--mscp-dir", mscp,
    "--mscp-script", compliance,
    ...(json ? ["--json"] : []),
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      TEST_MACOS_VERSION: version,
      TEST_MSCP_BRANCH: branch,
    },
  });

  try {
    mkdirSync(bin);
    mkdirSync(join(mscp, ".git"), { recursive: true });
    executable(compliance, "#!/bin/sh\nexit 0\n");
    executable(join(bin, "sw_vers"), "#!/bin/sh\nprintf '%s\\n' \"${TEST_MACOS_VERSION:?}\"\n");
    executable(join(bin, "gitleaks"), "#!/bin/sh\nexit 0\n");
    executable(join(bin, "trufflehog"), "#!/bin/sh\nexit 0\n");
    executable(join(bin, "sudo"), "#!/bin/sh\nexit 0\n");
    executable(join(bin, "git"), "#!/bin/sh\nprintf '%s\\n' \"${TEST_MSCP_BRANCH-}\"\n");

    for (const [version, branch] of branches) {
      const result = run(version, branch);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`mSCP branch looks correct: ${branch}`));
      assert.match(result.stdout, /security audit summary: 0 failed, 0 warnings/);
    }

    const future = run("27.0", "main");
    assert.equal(future.status, 0, future.stderr);
    assert.match(future.stderr, /no mSCP branch mapping for macOS 27\.0/);
    assert.match(future.stdout, /security audit summary: 0 failed, 1 warnings/);

    const detached = run("26.6", "");
    assert.equal(detached.status, 0, detached.stderr);
    assert.match(detached.stderr, /mSCP branch is detached; expected tahoe/);
    assert.match(detached.stdout, /security audit summary: 0 failed, 1 warnings/);

    const currentJson = run("26.6", "tahoe", true);
    assert.equal(currentJson.status, 0, currentJson.stderr);
    assert.deepEqual(JSON.parse(currentJson.stdout), {
      audit: "repo-security",
      status: "pass",
      failed: 0,
      warnings: 0,
      mscp: "enabled",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
