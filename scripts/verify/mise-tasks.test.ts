#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { auditCommand, runAudit } from "../audit/run.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function globalMiseConfigPath(env: NodeJS.ProcessEnv): string {
  return env.MISE_GLOBAL_CONFIG_FILE || resolve(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "mise/config.toml");
}

const globalMiseConfig = globalMiseConfigPath(process.env);
const miseEnv = {
  ...process.env,
  MISE_IGNORED_CONFIG_PATHS: [process.env.MISE_IGNORED_CONFIG_PATHS, globalMiseConfig].filter(Boolean).join(delimiter),
  MISE_TRUSTED_CONFIG_PATHS: [process.env.MISE_TRUSTED_CONFIG_PATHS, repoRoot].filter(Boolean).join(delimiter),
};
const publicTasks = [
  "agents:sync",
  "agents:update",
  "audit",
  "bootstrap:trust-agent-worktrees",
  "dotfiles:apply",
  "dotfiles:diff",
  "verify",
  "verify:bootstrap",
  "verify:devbox-services",
  "verify:domain",
  "verify:fast",
];

function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", env: { ...miseEnv, ...env } });
}

test("mise exposes one validated task graph", () => {
  const validation = run("mise", ["tasks", "validate", "--errors-only"]);
  assert.equal(validation.status, 0, validation.stderr);

  const listing = run("mise", ["tasks", "--hidden", "--json"]);
  assert.equal(listing.status, 0, listing.stderr);
  const tasks = JSON.parse(listing.stdout) as Array<{ name: string; depends: string[]; hide: boolean; source: string; usage: string }>;
  assert.deepEqual(
    tasks.filter((task) => !task.hide).map((task) => task.name).sort(),
    publicTasks,
  );
  assert.deepEqual(tasks.find((task) => task.name === "verify")?.depends.sort(), ["verify:fast", "verify:history"]);
  assert.ok(tasks.every((task) => task.source === resolve(repoRoot, "mise.toml")));
  assert.ok(tasks.find((task) => task.name === "audit")?.usage.includes("<scope>"));
  assert.ok(tasks.find((task) => task.name === "verify:bootstrap")?.usage.includes("<profile>"));
});

test("empty mise config environment values use the default path", () => {
  assert.equal(
    globalMiseConfigPath({ MISE_GLOBAL_CONFIG_FILE: "", XDG_CONFIG_HOME: "" }),
    join(homedir(), ".config/mise/config.toml"),
  );
});

test("repository verification reports a missing Node runtime", () => {
  const bin = mkdtempSync(join(tmpdir(), "dotfiles-repo-runner-bin-"));
  try {
    symlinkSync("/usr/bin/dirname", join(bin, "dirname"));
    symlinkSync("/usr/bin/false", join(bin, "node"));
    const result = spawnSync("/bin/bash", [join(repoRoot, "scripts/verify/repo.sh"), "--skip-security"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: bin },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing node; run mise install before repository verification/);
  } finally {
    rmSync(bin, { force: true, recursive: true });
  }
});

test("task arguments fail before live commands run", () => {
  assert.notEqual(run("mise", ["run", "audit", "unknown"]).status, 0);
  assert.notEqual(run("mise", ["run", "verify:bootstrap", "unknown"]).status, 0);
});

test("focused verification preserves the delegated failure code", () => {
  const bin = mkdtempSync(join(tmpdir(), "dotfiles-mise-bin-"));
  try {
    const node = join(bin, "node");
    writeFileSync(node, "#!/bin/sh\n[ \"${1:-}\" = --version ] && exit 0\nexit 23\n");
    chmodSync(node, 0o755);
    const result = run("mise", ["run", "verify:domain", "static"], { PATH: `${bin}:${process.env.PATH ?? ""}` });
    assert.equal(result.status, 23, result.stderr);
  } finally {
    rmSync(bin, { force: true, recursive: true });
  }
});

test("audit routing is explicit and preserves failures", () => {
  assert.deepEqual(auditCommand("repo", "json")[1], ["--skip-mscp", "--json"]);
  assert.deepEqual(auditCommand("mscp", "text")[1], []);
  assert.equal(auditCommand("workstation", "text")[0], process.execPath);
  assert.match(auditCommand("workstation", "text")[1][0], /scripts\/audit\/workstation\.ts$/);
  assert.equal(auditCommand("devbox", "text")[0], process.execPath);
  assert.match(auditCommand("devbox", "json")[1][0], /scripts\/audit\/devbox\.ts$/);
  assert.equal(runAudit("host", "text", () => ({ status: 29 })), 29);
});
