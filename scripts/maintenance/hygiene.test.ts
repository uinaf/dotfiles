import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cacheCleanup, cacheCleanupTimeoutMs, candidates, capLogs, cleanRepository, discoverRepositories, openFiles, readState, type Runner } from "./hygiene.ts";

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

test("inactive and explicitly excluded checkouts need no remote access", () => {
  const f = fixture();
  try {
    f.git(f.repo, "worktree", "remove", f.tree);
    f.git(f.repo, "branch", "-d", "finished");
    const offline: Runner = (cwd, command, args) => {
      if (args[0] === "ls-remote" || args[0] === "remote") throw new Error("unexpected network access");
      return runner(cwd, command, args);
    };
    const result = cleanRepository(f.repo, f.roots, {}, week, true, () => [], offline);
    assert.deepEqual(result, { entries: [], candidates: {} });
    assert.ok(existsSync(join(f.repo, "tracked")));
    f.git(f.repo, "worktree", "add", "-b", "finished", f.tree);
    f.git(f.repo, "config", "--local", "dotfiles.hygiene", "skip");
    const excluded = cleanRepository(f.repo, f.roots, {}, week, true, () => [], offline);
    assert.equal(excluded.entries[0]?.result, "excluded by local dotfiles.hygiene=skip");
    assert.ok(existsSync(f.tree));
  } finally { f.cleanup(); }
});

test("log capping rewrites the same inode at a line boundary and keeps append descriptors valid", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "log-cap-")));
  try {
    const logs = join(root, "logs");
    mkdirSync(logs);
    const cap = 4096;
    const big = join(logs, "software-update.log");
    const content = Array.from({ length: 600 }, (_, index) => `line ${String(index).padStart(4, "0")} of the update log`).join("\n") + "\n";
    writeFileSync(big, content);
    writeFileSync(join(logs, "homebrew-update.log"), "short\n");
    writeFileSync(join(logs, "notes.txt"), "x".repeat(cap * 2));
    symlinkSync(big, join(logs, "linked.log"));
    const before = statSync(big).ino;
    const appender = openSync(big, "a"); // simulates launchd's held O_APPEND descriptor
    const entries = capLogs(logs, cap);
    assert.deepEqual(entries.map(entry => entry.target), [big]);
    assert.match(entries[0]!.result, /^capped from \d+ to \d+ bytes$/);
    const after = statSync(big);
    assert.equal(after.ino, before, "rotation must not replace the inode");
    assert.ok(after.size <= cap);
    const text = readFileSync(big, "utf8");
    assert.ok(content.endsWith(text), "the retained content must be the log tail");
    assert.match(text, /^line \d{4} of the update log/, "the tail must start on a line boundary");
    writeSync(appender, Buffer.from("appended after cap\n"));
    closeSync(appender);
    assert.ok(readFileSync(big, "utf8").endsWith("appended after cap\n"));
    assert.equal(readFileSync(join(logs, "homebrew-update.log"), "utf8"), "short\n");
    assert.equal(statSync(join(logs, "notes.txt")).size, cap * 2);
    assert.deepEqual(capLogs(join(root, "missing")), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a concurrent append between truncate and the tail write is interleaved, not overwritten", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hygiene-logs-")));
  try {
    const cap = 512;
    const log = join(root, "homebrew-update.log");
    writeFileSync(log, Array.from({ length: 100 }, (_, index) => `line ${String(index).padStart(3, "0")}`).join("\n") + "\n");
    const appender = openSync(log, "a"); // the other user's live launchd descriptor
    const entries = capLogs(root, cap, () => { writeSync(appender, Buffer.from("concurrent append\n")); });
    closeSync(appender);
    assert.equal(entries.length, 1);
    const text = readFileSync(log, "utf8");
    assert.ok(text.startsWith("concurrent append\n"), `the concurrent line must survive: ${JSON.stringify(text.slice(0, 40))}`);
    assert.ok(text.endsWith("line 099\n"), "the retained tail follows the concurrent line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("process inventory suppresses lsof warning-induced exits but stays fail-closed", () => {
  let seen: string[] = [];
  const paths = openFiles("/fixture", (_cwd, command, args) => {
    assert.equal(command, "lsof");
    seen = args;
    return { status: 0, stdout: "p1\0n/fixture/file\0" };
  });
  assert.equal(seen[0], "-w");
  assert.deepEqual(paths, ["/fixture/file"]);
  // A warning-free nonzero exit (a real lsof failure) still fails closed.
  assert.throws(() => openFiles("/fixture", () => ({ status: 1, stdout: "" })), /retained local work/);
  // No paths at all is indistinguishable from a broken inventory: fail closed.
  assert.throws(() => openFiles("/fixture", () => ({ status: 0, stdout: "" })), /process activity unavailable/);
});

test("undecodable hygiene state is treated as empty so cleanup can continue", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hygiene-state-")));
  try {
    const statePath = join(root, "hygiene.json");
    const empty = { lastRun: 0, lastCache: 0, candidates: {} };
    assert.deepEqual(readState(statePath), { state: empty, recovered: false });
    writeFileSync(statePath, "{ not json");
    assert.deepEqual(readState(statePath), { state: empty, recovered: true });
    writeFileSync(statePath, JSON.stringify({ wrong: "shape" }));
    assert.deepEqual(readState(statePath), { state: empty, recovered: true });
    const valid = { lastRun: 5, lastCache: 6, candidates: { key: { head: "a".repeat(40), since: 7 } } };
    writeFileSync(statePath, JSON.stringify(valid));
    assert.deepEqual(readState(statePath), { state: valid, recovered: false });
    // A directory at the state path is neither missing nor undecodable JSON: it must not bypass the weekly gate.
    const directoryPath = join(root, "state-directory.json");
    mkdirSync(directoryPath);
    assert.throws(() => readState(directoryPath), { code: "EISDIR" });
    if (process.getuid?.() !== 0) {
      chmodSync(statePath, 0o000);
      assert.throws(() => readState(statePath), { code: "EACCES" });
      chmodSync(statePath, 0o600);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cache cleanup runs under its dedicated generous timeout, not the shared 60s one", () => {
  const captured: { args?: readonly string[]; options?: { timeout?: number } } = {};
  const spawn = ((_command: string, args: readonly string[], options: { timeout?: number }) => {
    captured.args = args;
    captured.options = options;
    return { status: 0, stdout: "ok", stderr: "", pid: 1, output: [], signal: null, error: undefined };
  }) as unknown as typeof spawnSync;
  assert.deepEqual(cacheCleanup("/fixture/home", false, spawn), { status: 0, stdout: "ok" });
  assert.equal(cacheCleanupTimeoutMs, 30 * 60_000);
  assert.equal(captured.options?.timeout, cacheCleanupTimeoutMs);
  assert.equal(captured.args?.[1], "--dry-run");
  assert.deepEqual(cacheCleanup("/fixture/home", true, spawn), { status: 0, stdout: "ok" });
  assert.equal(captured.args?.length, 1, "apply mode must not pass --dry-run");
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
