import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "vite-plus/test";
import { migrateLegacyLock } from "./lock.ts";

function fixture(t: TestContext) {
  const repo = mkdtempSync(join(tmpdir(), "agent-lock-migration-"));
  t.onTestFinished(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, "scripts/agents"), { recursive: true });
  mkdirSync(join(repo, "agents"));
  return {
    repo,
    old: join(repo, "scripts/agents/skills.lock.json"),
    current: join(repo, "agents/skills.lock.json"),
  };
}

test("legacy ownership survives relocation and repeated sync", (t) => {
  const f = fixture(t);
  writeFileSync(f.old, '{"version":1,"skills":[]}', { mode: 0o600 });
  assert.equal(migrateLegacyLock(f.repo, "skills"), f.current);
  assert.equal(readFileSync(f.current, "utf8"), '{"version":1,"skills":[]}');
  assert.equal(statSync(f.current).mode & 0o777, 0o600);
  assert.equal(existsSync(f.old), false);
  assert.equal(migrateLegacyLock(f.repo, "skills"), f.current);
});

test("a fresh checkout returns the new path without manufacturing ownership", (t) => {
  const f = fixture(t);
  assert.equal(migrateLegacyLock(f.repo, "skills"), f.current);
  assert.equal(existsSync(f.current), false);
});

test("conflicting ownership files are both preserved", (t) => {
  const f = fixture(t);
  writeFileSync(f.old, "old", { mode: 0o600 });
  writeFileSync(f.current, "current", { mode: 0o600 });
  assert.throws(() => migrateLegacyLock(f.repo, "skills"), /Both legacy and current/);
  assert.equal(readFileSync(f.old, "utf8"), "old");
  assert.equal(readFileSync(f.current, "utf8"), "current");
});

test("an interrupted exclusive move resumes", (t) => {
  const f = fixture(t);
  writeFileSync(f.old, "ownership", { mode: 0o600 });
  linkSync(f.old, f.current);
  assert.equal(migrateLegacyLock(f.repo, "skills"), f.current);
  assert.equal(existsSync(f.old), false);
  assert.equal(readFileSync(f.current, "utf8"), "ownership");
});

test("unsafe legacy files and symlinked directories are rejected", (t) => {
  const f = fixture(t);
  symlinkSync(join(f.repo, "missing"), f.old);
  assert.throws(() => migrateLegacyLock(f.repo, "skills"), /owner-only regular file/);
  rmSync(f.old);
  writeFileSync(f.old, "ownership", { mode: 0o600 });
  chmodSync(f.old, 0o644);
  assert.throws(() => migrateLegacyLock(f.repo, "skills"), /owner-only regular file/);
  rmSync(join(f.repo, "agents"), { recursive: true });
  symlinkSync(join(f.repo, "scripts/agents"), join(f.repo, "agents"));
  assert.throws(() => migrateLegacyLock(f.repo, "skills"), /must not be a symlink/);
});
