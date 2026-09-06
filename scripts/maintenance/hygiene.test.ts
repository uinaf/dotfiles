import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { candidates, cleanRepository, discoverRepositories, openFiles, type Runner } from "./hygiene.ts";

const week = 7 * 86400_000;
const runner: Runner = (cwd, command, args) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
};

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "host-hygiene-")));
  const git = (cwd: string, ...args: string[]) => {
    const result = runner(cwd, "git", args);
    assert.equal(result.status, 0, `git ${args.join(" ")}`);
    return result.stdout.trim();
  };
  const remote = join(root, "remote.git");
  git(root, "init", "--bare", "--initial-branch=main", remote);
  const repo = join(root, "projects/org/repo");
  mkdirSync(join(root, "projects/org"), { recursive: true });
  git(root, "clone", remote, repo);
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "core.hooksPath", "/dev/null");
  writeFileSync(join(repo, "tracked"), "initial\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  git(repo, "push", "-u", "origin", "main");
  const roots = [join(root, "worktrees")];
  const tree = join(roots[0], "finished");
  git(repo, "worktree", "add", "-b", "finished", tree);
  return { root, repo, roots, tree, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("clean merged worktree waits seven days, is removed without force, then its branch is separately eligible", () => {
  const f = fixture();
  try {
    const first = cleanRepository(f.repo, f.roots, {}, week, true, () => [], runner);
    assert.ok(existsSync(f.tree));
    const second = cleanRepository(f.repo, f.roots, first.candidates, 2 * week, true, () => [], runner);
    assert.equal(existsSync(f.tree), false);
    assert.ok(second.entries.some(entry => entry.result === "removed"));
    const branch = cleanRepository(f.repo, f.roots, {}, 3 * week, true, () => [], runner);
    cleanRepository(f.repo, f.roots, branch.candidates, 4 * week, true, () => [], runner);
    assert.equal(f.git(f.repo, "for-each-ref", "--format=%(refname)", "refs/heads/finished"), "");
    assert.ok(existsSync(f.repo));
  } finally { f.cleanup(); }
});

test("dirty, ignored, locked, active and detached worktrees are retained", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.tree, "untracked"), "keep");
    assert.equal(candidates(f.repo, f.roots, [], runner).eligible.length, 0);
    rmSync(join(f.tree, "untracked"));
    writeFileSync(join(f.repo, ".git/info/exclude"), ".env\nnode_modules/\n");
    writeFileSync(join(f.tree, ".env"), "keep");
    assert.equal(candidates(f.repo, f.roots, [], runner).eligible.length, 0);
    rmSync(join(f.tree, ".env"));
    mkdirSync(join(f.tree, "node_modules"));
    writeFileSync(join(f.tree, "node_modules/generated"), "regenerable");
    assert.equal(candidates(f.repo, f.roots, [], runner).eligible.length, 1);
    assert.equal(candidates(f.repo, f.roots, [join(f.tree, "tracked")], runner).eligible.length, 0);
    f.git(f.repo, "worktree", "lock", f.tree);
    assert.equal(candidates(f.repo, f.roots, [], runner).eligible.length, 0);
    f.git(f.repo, "worktree", "unlock", f.tree);
    f.git(f.tree, "checkout", "--detach");
    assert.ok(candidates(f.repo, f.roots, [], runner).kept.some(entry => entry.result.includes("detached")));
  } finally { f.cleanup(); }
});

test("unmerged commits survive even when their remote branch is gone", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.tree, "tracked"), "unmerged work\n");
    f.git(f.tree, "commit", "-am", "keep");
    f.git(f.tree, "push", "-u", "origin", "finished");
    f.git(f.repo, "push", "origin", "--delete", "finished");
    assert.equal(candidates(f.repo, f.roots, [], runner).eligible.length, 0);
  } finally { f.cleanup(); }
});

test("activity arriving at removal time cancels eligibility", () => {
  const f = fixture();
  try {
    const first = cleanRepository(f.repo, f.roots, {}, week, true, () => [], runner);
    let checks = 0;
    const second = cleanRepository(f.repo, f.roots, first.candidates, 2 * week, true,
      () => ++checks === 1 ? [] : [f.tree], runner);
    assert.ok(existsSync(f.tree));
    assert.equal(Object.keys(second.candidates).length, 0);
  } finally { f.cleanup(); }
});

test("existing upstreams and long-lived branches stay, changed HEAD restarts the grace period", () => {
  const f = fixture();
  try {
    f.git(f.tree, "push", "-u", "origin", "finished");
    f.git(f.repo, "branch", "release/stable");
    assert.equal(candidates(f.repo, f.roots, [], runner).eligible.length, 0);
    f.git(f.repo, "push", "origin", "--delete", "finished");
    const first = cleanRepository(f.repo, f.roots, {}, week, true, () => [], runner);
    writeFileSync(join(f.tree, "tracked"), "more merged work\n");
    f.git(f.tree, "commit", "-am", "more work");
    f.git(f.tree, "push", "origin", "HEAD:main");
    const second = cleanRepository(f.repo, f.roots, first.candidates, 2 * week, true, () => [], runner);
    assert.ok(existsSync(f.tree));
    assert.equal(Object.values(second.candidates)[0]?.since, 2 * week);
    assert.equal(f.git(f.repo, "for-each-ref", "--format=%(refname)", "refs/heads/release/stable"), "refs/heads/release/stable");
  } finally { f.cleanup(); }
});

test("dry-run never deletes, failed remote reads and activity probes fail closed", () => {
  const f = fixture();
  try {
    const first = cleanRepository(f.repo, f.roots, {}, week, true, () => [], runner);
    f.git(f.tree, "push", "-u", "origin", "finished");
    f.git(f.root, "--git-dir", join(f.root, "remote.git"), "update-ref", "-d", "refs/heads/finished");
    cleanRepository(f.repo, f.roots, first.candidates, 2 * week, false, () => [], runner);
    assert.ok(existsSync(f.tree));
    assert.equal(f.git(f.repo, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/finished"), "refs/remotes/origin/finished");
    const failed: Runner = (cwd, command, args) => args[0] === "ls-remote" ? { status: 1, stdout: "" } : runner(cwd, command, args);
    assert.throws(() => cleanRepository(f.repo, f.roots, first.candidates, 2 * week, true, () => [], failed));
    assert.throws(() => openFiles(f.root, () => ({ status: 1, stdout: "" })));
    assert.ok(existsSync(f.tree));
    const missing: Runner = (cwd, command, args) => args[0] === "cat-file" ? { status: 1, stdout: "" } : runner(cwd, command, args);
    const skipped = cleanRepository(f.repo, f.roots, first.candidates, 2 * week, true, () => [], missing);
    assert.equal(skipped.entries[0]?.result, "remote default history missing locally; retained for normal sync");
    assert.ok(existsSync(f.tree));
  } finally { f.cleanup(); }
});

test("repository discovery ignores symlinks and stays within its depth", () => {
  const f = fixture();
  try {
    symlinkSync(f.repo, join(f.root, "projects/linked"));
    assert.deepEqual(discoverRepositories(join(f.root, "projects")), [f.repo]);
  } finally { f.cleanup(); }
});

test("cache cleanup preserves archives and stopped containers, previews without deleting, and reports failures", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cache-hygiene-")));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const calls = join(root, "calls");
    for (const name of ["xcrun", "pnpm", "docker"]) {
      const script = join(bin, name);
      writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' '${name}' "$*" >> "$CALLS"\nexit "\${FAKE_EXIT:-0}"\n`);
      chmodSync(script, 0o755);
    }
    const archives = join(root, "Library/Developer/Xcode/Archives");
    const derived = join(root, "Library/Developer/Xcode/DerivedData");
    mkdirSync(archives, { recursive: true });
    mkdirSync(derived, { recursive: true });
    const valuable = join(archives, "release.xcarchive");
    const cache = join(derived, "old-cache");
    writeFileSync(valuable, "release symbols");
    writeFileSync(cache, "build output");
    const old = new Date(Date.now() - 40 * 86400_000);
    utimesSync(cache, old, old);
    const execute = (args: string[], failed = false) => spawnSync("/bin/sh", [join(import.meta.dirname, "cache-cleanup.sh"), ...args], {
      encoding: "utf8", env: { HOME: root, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, CALLS: calls, FAKE_EXIT: failed ? "1" : "0" },
    });
    assert.equal(execute(["--dry-run"]).status, 0);
    assert.ok(existsSync(cache));
    assert.equal(execute([]).status, 0);
    assert.equal(existsSync(cache), false);
    assert.ok(existsSync(valuable));
    assert.doesNotMatch(readFileSync(calls, "utf8"), /container prune|image prune|system prune/);
    assert.equal(execute([], true).status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
