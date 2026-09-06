import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireDirectoryLock, lockOwnerAlive, processAlive } from "./lock.ts";

function fixture(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "converge.lock");
}

const silent = { log: () => {} };

test("acquiring records owner metadata and releasing removes the lock", t => {
  const lock = fixture(t);
  const release = acquireDirectoryLock(lock, silent);
  const metadata = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
  assert.equal(metadata.pid, process.pid);
  assert.equal(typeof metadata.bootTime, "number");
  assert.throws(() => acquireDirectoryLock(lock, silent), /held by an active process/);
  release();
  assert.equal(existsSync(lock), false);
});

test("a dead holder is reclaimed and the lock is reacquired", t => {
  const lock = fixture(t);
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), `${JSON.stringify({ pid: 4_000_000, bootTime: Date.now() })}\n`);
  const messages: string[] = [];
  const release = acquireDirectoryLock(lock, { processAlive: () => false, log: message => messages.push(message) });
  assert.equal(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).pid, process.pid);
  assert.ok(messages.some(message => message.includes("reclaiming stale lock")));
  release();
  assert.equal(existsSync(lock), false);
});

test("a holder recorded before the current boot is reclaimed even when its pid looks alive", t => {
  const lock = fixture(t);
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid, bootTime: 500 })}\n`);
  const probe = { now: () => 1_000_000_000, uptimeMs: () => 1_000, processAlive: () => true };
  assert.equal(lockOwnerAlive(lock, probe), false);
  const release = acquireDirectoryLock(lock, { ...silent, ...probe });
  release();
});

test("EPERM from the liveness probe means alive", () => {
  // pid 1 (launchd) rejects signal 0 from an unprivileged user with EPERM.
  assert.equal(processAlive(1), true);
  assert.equal(processAlive(process.pid), true);
});

test("malformed or missing metadata is treated as a live holder", t => {
  const lock = fixture(t);
  mkdirSync(lock); // bare mkdir lock without metadata
  assert.equal(lockOwnerAlive(lock, { processAlive: () => false }), true);
  assert.throws(() => acquireDirectoryLock(lock, { ...silent, processAlive: () => false }), /held by an active process/);
  writeFileSync(join(lock, "owner.json"), "not json");
  assert.equal(lockOwnerAlive(lock, { processAlive: () => false }), true);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: "12", bootTime: "later" }));
  assert.equal(lockOwnerAlive(lock, { processAlive: () => false }), true);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: -1, bootTime: 0 }));
  assert.equal(lockOwnerAlive(lock, { processAlive: () => false }), true);
  assert.ok(existsSync(lock));
});

test("contention waits with backoff and acquires after release, without real sleeping", t => {
  const lock = fixture(t);
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), `${JSON.stringify({ pid: 1234, bootTime: 0 })}\n`);
  let time = 0;
  const slept: number[] = [];
  const release = acquireDirectoryLock(lock, {
    waitMs: 900_000,
    now: () => time,
    uptimeMs: () => time,
    processAlive: () => true,
    log: () => {},
    sleep: ms => {
      slept.push(ms);
      time += ms;
      if (time >= 30_000) rmSync(lock, { recursive: true, force: true });
    },
  });
  assert.deepEqual(slept, [5_000, 10_000, 20_000]);
  release();
  assert.equal(existsSync(lock), false);
});

test("an unreleased lock fails loudly after the wait budget", t => {
  const lock = fixture(t);
  mkdirSync(lock);
  let time = 0;
  const slept: number[] = [];
  const messages: string[] = [];
  assert.throws(() => acquireDirectoryLock(lock, {
    waitMs: 900_000,
    now: () => time,
    log: message => messages.push(message),
    sleep: ms => {
      slept.push(ms);
      time += ms;
    },
  }), /held by an active process/);
  assert.equal(slept.reduce((sum, ms) => sum + ms, 0), 900_000);
  assert.ok(slept.every(ms => ms <= 60_000));
  assert.ok(messages.some(message => message.includes("waiting up to 15 minutes")));
});
