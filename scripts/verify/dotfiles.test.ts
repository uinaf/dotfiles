#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readProfileModel } from "../profiles/model.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const modelPath = join(repoRoot, "chezmoi/.chezmoidata/profiles.json");
const profiles = Object.keys(readProfileModel(modelPath).profiles);

function writeDelegate(path: string, label: string): void {
  writeFileSync(path, `#!/usr/bin/env bash
printf '%s' '${label}' >> "\${DOTFILES_TEST_LOG:?}"
printf ' %q' "$@" >> "\${DOTFILES_TEST_LOG:?}"
printf '\\n' >> "\${DOTFILES_TEST_LOG:?}"
if [ "\${DOTFILES_TEST_EXIT:-0}" -ne 0 ]; then exit "\${DOTFILES_TEST_EXIT}"; fi
if [ '${label}' = install.sh ] && [ "\${1:-}" = --print-steps ]; then printf 'apply-dotfiles\\ninstall-runtimes\\n'; fi
`);
  chmodSync(path, 0o755);
}

test("operator command validates and delegates every profile", () => {
  const fixture = mkdtempSync(join(tmpdir(), "dotfiles-command-"));
  const home = join(fixture, "home");
  const log = join(fixture, "commands.log");
  const command = join(fixture, "repo/dotfiles");
  const run = (args: string[], exit = 0) => spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, DOTFILES_TEST_EXIT: String(exit), DOTFILES_TEST_LOG: log, HOME: home },
  });

  try {
    mkdirSync(join(fixture, "repo/scripts/bootstrap"), { recursive: true });
    mkdirSync(join(fixture, "repo/scripts/verify"), { recursive: true });
    mkdirSync(join(fixture, "repo/scripts/lib"), { recursive: true });
    mkdirSync(join(fixture, "repo/chezmoi/.chezmoidata"), { recursive: true });
    mkdirSync(home);
    cpSync(join(repoRoot, "dotfiles"), command);
    chmodSync(command, 0o755);
    cpSync(join(repoRoot, "scripts/lib/profile.sh"), join(fixture, "repo/scripts/lib/profile.sh"));
    cpSync(modelPath, join(fixture, "repo/chezmoi/.chezmoidata/profiles.json"));
    writeDelegate(join(fixture, "repo/scripts/bootstrap/install.sh"), "install.sh");
    writeDelegate(join(fixture, "repo/scripts/bootstrap/apply-dotfiles.sh"), "apply-dotfiles.sh");
    writeDelegate(join(fixture, "repo/scripts/verify/bootstrap.sh"), "verify-bootstrap.sh");

    for (const profile of profiles) {
      writeFileSync(log, "");
      const diff = run(["diff", profile]);
      assert.equal(diff.status, 0, diff.stderr);
      assert.match(diff.stdout, new RegExp(`Per-user convergence steps for ${profile}:`));
      assert.match(diff.stderr, /Homebrew packages, identities, secrets, or host-wide settings/);
      assert.equal(
        readFileSync(log, "utf8"),
        `install.sh --print-steps --profile ${profile}\napply-dotfiles.sh --profile ${profile} --dry-run --verbose\n`,
      );

      writeFileSync(log, "");
      const apply = run(["apply", profile]);
      assert.equal(apply.status, 0, apply.stderr);
      assert.match(apply.stderr, /Homebrew packages, identities, secrets, or host-wide settings/);
      assert.equal(readFileSync(log, "utf8"), `install.sh --profile ${profile}\n`);
      const secondApply = run(["apply", profile]);
      assert.equal(secondApply.status, 0, secondApply.stderr);
      assert.equal(
        readFileSync(log, "utf8"),
        `install.sh --profile ${profile}\ninstall.sh --profile ${profile}\n`,
      );

      writeFileSync(log, "");
      const check = run(["check", profile]);
      assert.equal(check.status, 0, check.stderr);
      assert.match(check.stderr, /Homebrew packages, identities, secrets, or host-wide settings/);
      assert.equal(readFileSync(log, "utf8"), `verify-bootstrap.sh --profile ${profile}\n`);
    }

    writeFileSync(log, "");
    assert.equal(run(["apply", "unknown"]).status, 2);
    assert.equal(run(["unknown", "workstation"]).status, 2);
    assert.equal(run(["apply"]).status, 2);
    assert.equal(readFileSync(log, "utf8"), "");
    const failed = run(["apply", "workstation"], 29);
    assert.equal(failed.status, 29);
    assert.match(failed.stderr, /scripts\/bootstrap\/install\.sh failed/);
    assert.match(failed.stderr, /rerun \.\/dotfiles apply workstation/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
