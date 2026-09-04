#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readProfileModel } from "../profiles/model.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const modelPath = join(repoRoot, "chezmoi/.chezmoidata/profiles.json");
const profiles = Object.keys(readProfileModel(modelPath).profiles);

type RunResult = { status: number | null; stdout: string; stderr: string };

function writeDelegate(path: string, label: string): void {
  writeFileSync(path, `#!/usr/bin/env bash
printf '%s' '${label}' >> "\${DOTFILES_TEST_LOG:?}"
printf ' %q' "$@" >> "\${DOTFILES_TEST_LOG:?}"
printf '\\n' >> "\${DOTFILES_TEST_LOG:?}"
if [ "\${DOTFILES_TEST_EXIT:-0}" -ne 0 ]; then exit "\${DOTFILES_TEST_EXIT}"; fi
if [ '${label}' = install.ts ] && [ "\${1:-}" = --print-steps ]; then printf 'apply-dotfiles\\ninstall-runtimes\\n'; fi
`);
  chmodSync(path, 0o755);
}

test("operator command validates and delegates every profile", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "dotfiles-command-"));
  const home = join(fixture, "home");
  const command = join(repoRoot, "scripts/dotfiles.ts");
  const run = (args: string[], log: string, exit = 0): Promise<RunResult> =>
    new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [command, ...args], {
        env: {
          ...process.env,
          DOTFILES_OPERATOR_REPO_ROOT: join(fixture, "repo"),
          DOTFILES_TEST_EXIT: String(exit),
          DOTFILES_TEST_LOG: log,
          HOME: home,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", rejectPromise);
      child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
    });

  try {
    mkdirSync(join(fixture, "repo/scripts/bootstrap"), { recursive: true });
    mkdirSync(join(fixture, "repo/scripts/verify"), { recursive: true });
    mkdirSync(join(fixture, "repo/chezmoi/.chezmoidata"), { recursive: true });
    mkdirSync(home);
    cpSync(modelPath, join(fixture, "repo/chezmoi/.chezmoidata/profiles.json"));
    writeDelegate(join(fixture, "repo/scripts/bootstrap/install.ts"), "install.ts");
    writeDelegate(join(fixture, "repo/scripts/bootstrap/apply-dotfiles.ts"), "apply-dotfiles.ts");
    writeDelegate(join(fixture, "repo/scripts/verify/bootstrap.ts"), "verify-bootstrap.ts");

    await Promise.all(profiles.map(async (profile) => {
      const log = join(fixture, `commands-${profile}.log`);

      writeFileSync(log, "");
      const diff = await run(["diff", profile], log);
      assert.equal(diff.status, 0, diff.stderr);
      assert.match(diff.stdout, new RegExp(`Per-user convergence steps for ${profile}:`));
      assert.match(diff.stderr, /Homebrew packages, identities, secrets, or host-wide settings/);
      assert.equal(
        readFileSync(log, "utf8"),
        `install.ts --print-steps --profile ${profile}\napply-dotfiles.ts --profile ${profile} --dry-run --verbose\n`,
      );

      writeFileSync(log, "");
      const apply = await run(["apply", profile], log);
      assert.equal(apply.status, 0, apply.stderr);
      assert.match(apply.stderr, /Homebrew packages, identities, secrets, or host-wide settings/);
      assert.equal(readFileSync(log, "utf8"), `install.ts --profile ${profile}\n`);
      const secondApply = await run(["apply", profile], log);
      assert.equal(secondApply.status, 0, secondApply.stderr);
      assert.equal(
        readFileSync(log, "utf8"),
        `install.ts --profile ${profile}\ninstall.ts --profile ${profile}\n`,
      );

      writeFileSync(log, "");
      const check = await run(["check", profile], log);
      assert.equal(check.status, 0, check.stderr);
      assert.match(check.stderr, /Homebrew packages, identities, secrets, or host-wide settings/);
      assert.equal(readFileSync(log, "utf8"), `verify-bootstrap.ts --profile ${profile}\n`);
    }));

    const log = join(fixture, "commands.log");
    writeFileSync(log, "");
    assert.equal((await run(["apply", "unknown"], log)).status, 2);
    assert.equal((await run(["unknown", "workstation"], log)).status, 2);
    assert.equal((await run(["apply"], log)).status, 2);
    assert.equal(readFileSync(log, "utf8"), "");
    const failed = await run(["apply", "workstation"], log, 29);
    assert.equal(failed.status, 29);
    assert.match(failed.stderr, /scripts\/bootstrap\/install\.ts failed/);
    assert.match(failed.stderr, /rerun \.\/dotfiles apply workstation/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("fresh checkout launcher prepares dependencies without applying a profile", async () => {
  const { spawnSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "dotfiles-prepare-"));
  try {
    cpSync(join(repoRoot, "dotfiles"), join(root, "dotfiles"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    const log = join(root, "commands");
    writeFileSync(join(bin, "mise"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_LOG"\nexit "${TEST_EXIT:-0}"\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, TEST_LOG: log };
    const help = spawnSync("/bin/sh", [join(root, "dotfiles"), "--help"], { env, encoding: "utf8" });
    assert.equal(help.status, 0, help.stderr);
    assert.deepEqual((await import("node:fs")).readdirSync(root).sort(), ["bin", "dotfiles"]);
    const prepared = spawnSync("/bin/sh", [join(root, "dotfiles"), "prepare"], { env, encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(readFileSync(log, "utf8"), `--no-config x node@24.19.0 -- corepack pnpm --dir ${root} install --frozen-lockfile\n`);
    const failed = spawnSync("/bin/sh", [join(root, "dotfiles"), "prepare"], { env: { ...env, TEST_EXIT: "23" }, encoding: "utf8" });
    assert.equal(failed.status, 23);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
