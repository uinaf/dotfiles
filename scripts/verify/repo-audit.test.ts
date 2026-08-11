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
function executable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

test("repo audit uses the mSCP 2.0 versioned artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-repo-audit-"));
  const bin = join(root, "bin");
  const mscp = join(root, "macos_security");
  const compliance = join(root, "compliance.sh");
  const run = (version: string, json = false) => spawnSync(audit, [
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

    for (const version of ["14.7.7", "15.7.3", "26.6", "27.0"]) {
      const result = run(version);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /security audit summary: 0 failed, 0 warnings/);
    }

    const currentJson = run("26.6", true);
    assert.equal(currentJson.status, 0, currentJson.stderr);
    assert.deepEqual(JSON.parse(currentJson.stdout), {
      audit: "repo-security",
      status: "pass",
      failed: 0,
      warnings: 0,
      mscp: "enabled",
    });

    const generated = join(mscp, "build", "800-53r5_moderate_macos_26.0", "800-53r5_moderate_macos_26.0_compliance.sh");
    mkdirSync(dirname(generated), { recursive: true });
    executable(generated, "#!/bin/sh\nexit 0\n");
    const defaultArtifact = spawnSync(audit, ["--mscp-dir", mscp], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        TEST_MACOS_VERSION: "26.6",
      },
    });
    assert.equal(defaultArtifact.status, 0, defaultArtifact.stderr);
    assert.match(defaultArtifact.stdout, /mSCP check passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
