#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { acquireDirectoryLock } from "../lib/lock.ts";
import { dailyLog } from "./logs.ts";

const week = 7 * 86400_000;
const gracePeriod = 3 * 86400_000;
const State = Schema.Struct({
  lastRun: Schema.Number,
  lastCache: Schema.Number,
  candidates: Schema.Record(Schema.String, Schema.Struct({ head: Schema.String, since: Schema.Number })),
});
type State = typeof State.Type;
type Result = { status: number; stdout: string };
export type Runner = (cwd: string, command: string, args: string[]) => Result;
export type Worktree = { path: string; branch: string; head: string; locked: boolean; prunable: boolean };
type Candidate = { kind: "worktree" | "branch"; path: string; branch: string; head: string };
type Entry = { target: string; result: string };

const run: Runner = (cwd, command, args) => {
  const result = spawnSync(command, args, {
    cwd, encoding: "utf8", timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: result.error ? 1 : result.status ?? 1, stdout: result.stdout ?? "" };
};

// Deleting aged caches legitimately takes minutes on a full disk, so the cache
// pass gets a dedicated generous budget; git and lsof keep the shared 60s timeout.
export const cacheCleanupTimeoutMs = 30 * 60_000;

export function cacheCleanup(home: string, apply: boolean, spawn: typeof spawnSync = spawnSync): Result {
  const result = spawn("/bin/sh", [join(import.meta.dirname, "cache-cleanup.sh"), ...apply ? [] : ["--dry-run"]], {
    cwd: home, encoding: "utf8", timeout: cacheCleanupTimeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: result.error ? 1 : result.status ?? 1, stdout: result.stdout ?? "" };
}

function checked(runner: Runner, cwd: string, command: string, args: string[]): string {
  const result = runner(cwd, command, args);
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed; retained local work`);
  return result.stdout.trim();
}

export function parseWorktrees(text: string): Worktree[] {
  return text.split("\0\0").filter(Boolean).map(block => {
    const fields = block.split("\0");
    const field = (name: string) => fields.find(value => value.startsWith(`${name} `))?.slice(name.length + 1) ?? "";
    if (!field("worktree") || !/^[0-9a-f]{40,64}$/.test(field("HEAD"))) throw new Error("invalid worktree inventory");
    return { path: field("worktree"), branch: field("branch"), head: field("HEAD"),
      locked: fields.some(value => value === "locked" || value.startsWith("locked ")),
      prunable: fields.some(value => value === "prunable" || value.startsWith("prunable ")) };
  });
}

export function discoverRepositories(root: string, depth = 2): string[] {
  if (!existsSync(root) || lstatSync(root).isSymbolicLink()) return [];
  if (existsSync(join(root, ".git"))) return lstatSync(join(root, ".git")).isDirectory() ? [realpathSync(root)] : [];
  if (depth === 0) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
    .flatMap(entry => discoverRepositories(join(root, entry.name), depth - 1));
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

function busy(path: string, openPaths: readonly string[]): boolean {
  return openPaths.some(open => inside(open, path));
}

export function openFiles(home: string, runner: Runner = run): string[] {
  // -w suppresses warning-induced nonzero exits (for example unreadable mounts);
  // real failures still exit nonzero and fail closed below.
  const output = checked(runner, home, "lsof", ["-w", "-n", "-P", "-a", "-u", String(process.getuid?.()), "-F0n"]);
  const paths = output.split(/[\0\n]/).filter(field => field.startsWith("n/")).map(field => field.slice(1));
  if (paths.length === 0) throw new Error("process activity unavailable; retained local work");
  return paths;
}

function unfinished(repo: string, runner: Runner): boolean {
  return ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "index.lock"]
    .some(name => existsSync(resolve(repo, checked(runner, repo, "git", ["rev-parse", "--git-path", name]))));
}

export function candidates(repo: string, roots: readonly string[], openPaths: readonly string[], runner: Runner = run) {
  const git = (...args: string[]) => checked(runner, repo, "git", args);
  if (git("rev-parse", "--show-toplevel") !== realpathSync(repo) || !lstatSync(join(repo, ".git")).isDirectory()) {
    throw new Error("standalone owning checkout required");
  }
  const policy = runner(repo, "git", ["config", "--local", "--get", "dotfiles.hygiene"]);
  if (policy.status === 0 && policy.stdout.trim() === "skip") {
    return { eligible: [], kept: [{ target: repo, result: "excluded by local dotfiles.hygiene=skip" }] };
  }
  if (policy.status !== 0 && policy.status !== 1) throw new Error("local hygiene policy unavailable");
  const worktrees = parseWorktrees(git("worktree", "list", "--porcelain", "-z"));
  const checkedOut = new Set(worktrees.map(worktree => worktree.branch));
  const refs = git("for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads").split("\n").filter(Boolean);
  const longLived = (branch: string) => /^refs\/heads\/(main|master|develop|dev|production|staging|release)(\/|$)/.test(branch);
  const possibleTree = worktrees.slice(1).some(tree => tree.branch && !longLived(tree.branch) && !tree.locked && !tree.prunable
    && roots.some(root => tree.path !== root && inside(tree.path, root)));
  const possibleBranch = refs.some(row => {
    const [branch] = row.split("\0");
    return branch && !longLived(branch) && !checkedOut.has(branch) && !busy(repo, openPaths);
  });
  if (!possibleTree && !possibleBranch) return { eligible: [], kept: [] };
  // Observe the remote's current default rather than trusting a stale origin/HEAD.
  const remote = git("ls-remote", "--symref", "origin", "HEAD", "refs/heads/*");
  const defaultBranch = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(remote)?.[1];
  const target = /^([0-9a-f]{40,64})\tHEAD$/m.exec(remote)?.[1];
  if (!defaultBranch || !target) throw new Error("remote default branch unavailable");
  if (runner(repo, "git", ["cat-file", "-e", `${target}^{commit}`]).status !== 0) {
    return { eligible: [], kept: [{ target: repo, result: "remote default history missing locally; retained for normal sync" }] };
  }
  const remoteHeads = new Set(remote.split("\n").flatMap(line => {
    const match = /^[0-9a-f]{40,64}\trefs\/heads\/(.+)$/.exec(line);
    return match ? [match[1]] : [];
  }));
  const eligible: Candidate[] = [];
  const kept: Entry[] = [];
  const merged = (head: string) => runner(repo, "git", ["merge-base", "--is-ancestor", head, target]).status === 0;
  const protectedBranch = (branch: string) => {
    const name = branch.replace(/^refs\/heads\//, "");
    if (longLived(branch)) return true;
    const upstream = git("for-each-ref", "--format=%(upstream)", branch);
    if (remoteHeads.has(name)) return true;
    if (upstream.startsWith("refs/remotes/origin/")) return remoteHeads.has(upstream.slice("refs/remotes/origin/".length));
    return Boolean(upstream);
  };
  const worktreeReason = (tree: Worktree): string | undefined => {
    if (tree.path === repo || !roots.some(root => inside(tree.path, root) && tree.path !== root)) return "outside cleanup roots";
    if (tree.locked || tree.prunable || !tree.branch) return "locked, missing, or detached worktree";
    if (!existsSync(tree.path) || lstatSync(tree.path).isSymbolicLink() || realpathSync(tree.path) !== tree.path) return "non-canonical worktree path";
    if (tree.branch === `refs/heads/${defaultBranch}`) return "default branch";
    if (protectedBranch(tree.branch)) return "long-lived branch or existing upstream";
    if (busy(tree.path, openPaths)) return "active process or open file";
    if (unfinished(tree.path, runner)) return "unfinished Git operation";
    if (checked(runner, tree.path, "git", ["status", "--porcelain", "--untracked-files=all"])) return "dirty worktree";
    const ignored = checked(runner, tree.path, "git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
    if (ignored.split("\0").filter(Boolean).some(path => !/(^|\/)node_modules\/$/.test(path))) return "ignored local files retained";
    if (!merged(tree.head)) return "HEAD not in remote default (including squash merges)";
    return undefined;
  };
  for (const tree of worktrees.slice(1)) {
    const reason = worktreeReason(tree);
    if (reason) kept.push({ target: tree.path, result: reason });
    else eligible.push({ kind: "worktree", path: tree.path, branch: tree.branch, head: tree.head });
  }
  for (const row of refs) {
    const [branch, head] = row.split("\0");
    if (!branch || !head || branch === `refs/heads/${defaultBranch}` || checkedOut.has(branch) || protectedBranch(branch)) continue;
    if (busy(repo, openPaths) || unfinished(repo, runner)) {
      kept.push({ target: branch, result: "owning checkout active" });
    } else if (merged(head)) eligible.push({ kind: "branch", path: repo, branch, head });
    else kept.push({ target: branch, result: "commits not in remote default (including squash merges)" });
  }
  return { eligible, kept };
}

export function cleanRepository(
  repo: string, roots: readonly string[], previous: State["candidates"], now: number,
  apply: boolean, activity: () => string[], runner: Runner = run,
) {
  const initial = candidates(repo, roots, activity(), runner);
  if (apply && initial.eligible.length) checked(runner, repo, "git", ["remote", "prune", "origin"]);
  const next: Record<string, { head: string; since: number }> = {};
  const entries = [...initial.kept];
  for (const candidate of initial.eligible) {
    const key = JSON.stringify([repo, candidate.kind, candidate.path, candidate.branch]);
    const old = previous[key];
    const since = old?.head === candidate.head && old.since <= now ? old.since : now;
    next[key] = { head: candidate.head, since };
    if (!apply || now - since < gracePeriod) {
      entries.push({ target: candidate.kind === "branch" ? candidate.branch : candidate.path,
        result: now - since < gracePeriod ? "eligible; three-day grace period" : "would remove" });
      continue;
    }
    // Refresh remote, Git state, locks, and live activity immediately before removal.
    const fresh = candidates(repo, roots, activity(), runner).eligible.find(item =>
      item.kind === candidate.kind && item.path === candidate.path && item.branch === candidate.branch && item.head === candidate.head);
    if (!fresh) {
      delete next[key];
      entries.push({ target: candidate.path, result: "state changed; retained" });
      continue;
    }
    if (candidate.kind === "worktree") {
      const gitDirectory = checked(runner, candidate.path, "git", ["rev-parse", "--absolute-git-dir"]);
      const changedAt = Math.max(lastChanged(candidate.path), lastChanged(gitDirectory));
      if (now - changedAt < gracePeriod) {
        next[key] = { head: candidate.head, since: now };
        entries.push({ target: candidate.path, result: "changed within three days; grace period restarted" });
        continue;
      }
    }
    const args = candidate.kind === "worktree"
      ? ["worktree", "remove", candidate.path]
      : ["branch", "-d", "--", candidate.branch.replace(/^refs\/heads\//, "")];
    // No force flags: Git rechecks dirty/locked worktrees and checked-out branches.
    const result = runner(repo, "git", args);
    entries.push({ target: candidate.kind === "branch" ? candidate.branch : candidate.path,
      result: result.status === 0 ? "removed" : "Git refused removal; retained" });
    if (result.status === 0) delete next[key];
  }
  return { entries, candidates: next };
}

export function lastChanged(root: string): number {
  const pending = [root];
  let latest = 0;
  let visited = 0;
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined) break;
    if (++visited > 100_000) throw new Error("worktree activity inspection limit exceeded; retained local work");
    const info = lstatSync(path);
    latest = Math.max(latest, info.mtimeMs, info.ctimeMs, info.birthtimeMs);
    if (info.isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        // Dependency contents are regenerable; the directory itself still
        // records installs/removals without scanning an entire package store.
        if (entry.name === "node_modules" && entry.isDirectory()) {
          const dependency = lstatSync(join(path, entry.name));
          latest = Math.max(latest, dependency.mtimeMs, dependency.ctimeMs, dependency.birthtimeMs);
        } else pending.push(join(path, entry.name));
      }
    }
  }
  return latest;
}

export function readState(statePath: string): { state: State; recovered: boolean } {
  const empty: State = { lastRun: 0, lastCache: 0, candidates: {} };
  let text: string;
  try {
    text = readFileSync(statePath, "utf8");
  } catch (error) {
    // Only a missing file is an empty state. Any other read failure (EACCES,
    // EIO, EISDIR) must not silently restart grace periods or bypass the
    // weekly gate, so it propagates and fails the run.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: empty, recovered: false };
    throw error;
  }
  try {
    return { state: Schema.decodeUnknownSync(Schema.fromJsonString(State))(text), recovered: false };
  } catch {
    // Undecodable state only restarts every grace period and the cache
    // interval — strictly conservative — instead of failing every later run.
    return { state: empty, recovered: true };
  }
}

export const logCapBytes = 2 * 1024 * 1024;

// launchd opens each job's StandardOutPath/StandardErrorPath with O_APPEND and
// holds that descriptor for the whole run (the logs append across runs; see
// docs/software-updates.md). That O_APPEND assumption is empirical: it was
// verified with lsof against a live job, not taken from documentation.
// Rotation must reuse the same inode: a rename or unlink would orphan the live
// descriptor and silently discard all later output. Because writers append,
// the tail is written back through an O_APPEND descriptor too, so a concurrent
// append that lands between our truncate and our write is interleaved rather
// than overwritten (a positional write at offset 0 would clobber it; this is
// real on the devbox, where one user's updater appends to homebrew-update.log
// while another user's hygiene caps it). Residual caveat: lines appended
// between the tail read and the truncate are lost.
export function capLogs(directory: string, cap = logCapBytes, between: () => void = () => {}): Entry[] {
  const entries: Entry[] = [];
  if (!existsSync(directory)) return entries;
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".log")) continue;
    const path = join(directory, name);
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.size <= cap) continue;
      const fd = openSync(path, "r+");
      try {
        const tail = Buffer.alloc(cap);
        const read = readSync(fd, tail, 0, cap, info.size - cap);
        const newline = tail.indexOf(0x0a);
        const start = newline >= 0 && newline + 1 < read ? newline + 1 : 0; // drop the leading partial line
        ftruncateSync(fd, 0);
        between(); // test hook: a concurrent O_APPEND write landing here must survive
        const appender = openSync(path, "a");
        try { writeSync(appender, tail, start, read - start, null); } finally { closeSync(appender); }
      } finally { closeSync(fd); }
      entries.push({ target: path, result: `capped from ${info.size} to ${lstatSync(path).size} bytes` });
    } catch (error) {
      entries.push({ target: path, result: `log cap failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return entries;
}

export function hygiene(home: string, apply: boolean, scheduled: boolean, now = Date.now()): void {
  const directory = join(home, ".local/state/dotfiles");
  const statePath = join(directory, "hygiene.json");
  const { state, recovered } = readState(statePath);
  if (recovered) console.error(`Hygiene state was undecodable and is treated as empty; grace periods restart: ${statePath}`);
  if (scheduled && now >= state.lastRun && now - state.lastRun < week) {
    console.log("Host hygiene: next weekly run is not due.");
    return;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let release: () => void;
  // A lock left by a dead or pre-reboot process is reclaimed automatically;
  // a live or ambiguous owner still fails the run for inspection.
  try { release = acquireDirectoryLock(join(directory, "hygiene.lock")); }
  catch (cause) { throw new Error("hygiene lock exists; check for an active or interrupted cleanup", { cause }); }
  try {
    const roots = [".t3/worktrees", ".codex/worktrees", ".claude/worktrees"].map(path => join(home, path));
    const next: Record<string, { head: string; since: number }> = {};
    const reports: Record<string, Entry[]> = {};
    let failed = false;
    const activity = () => openFiles(home);
    for (const repo of discoverRepositories(join(home, "projects"))) {
      try {
        const result = cleanRepository(repo, roots, state.candidates, now, apply, activity);
        reports[repo] = result.entries;
        Object.assign(next, result.candidates);
      } catch (error) {
        failed = true;
        reports[repo] = [{ target: repo, result: error instanceof Error ? error.message : "inspection failed" }];
      }
    }
    const cacheDue = !scheduled || now - state.lastCache >= week;
    const cache = cacheDue
      ? cacheCleanup(home, apply)
      : { status: 0, stdout: "Cache cleanup is not due." };
    console.log(cache.stdout);
    failed ||= cache.status !== 0;
    const logs = apply ? capLogs(join(home, "Library/Logs/dotfiles")) : [];
    failed ||= logs.some(entry => entry.result.startsWith("log cap failed"));
    const report = JSON.stringify({ startedAt: new Date(now).toISOString(), finishedAt: new Date().toISOString(),
      apply, repositories: reports, cacheExitCode: cache.status, logs }, null, 2);
    console.log(report);
    if (apply) {
      writeFileSync(dailyLog(home, "hygiene", now), `${cache.stdout}\n${report}\n`, { flag: "a", mode: 0o600 });
      const temporary = `${statePath}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ lastRun: failed ? 0 : now,
        lastCache: cacheDue && cache.status === 0 ? now : state.lastCache, candidates: next }), { mode: 0o600 });
      renameSync(temporary, statePath);
    }
    if (failed) throw new Error("some hygiene checks failed; inspect the report");
  } finally { release(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    if (process.getuid?.() === 0 || process.argv.slice(2).some(arg => !["--apply", "--scheduled", "--dry-run"].includes(arg))) {
      throw new Error("Usage (as the owning user): hygiene.ts [--apply] [--scheduled] [--dry-run]");
    }
    hygiene(homedir(), process.argv.includes("--apply") && !process.argv.includes("--dry-run"),
      process.argv.includes("--scheduled") && !process.argv.includes("--dry-run"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "hygiene failed");
    process.exitCode = 1;
  }
}
