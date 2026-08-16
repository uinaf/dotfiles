import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const verifyDir = dirname(fileURLToPath(import.meta.url));
const hook = resolve(verifyDir, "pre-push.ts");
const installer = resolve(verifyDir, "install-pre-push-hook.sh");

type Repository = {
  path: string;
  oidLength: number;
  zeroOid: string;
};

function run(path: string, args: string[], allowFailure = false): string {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: path,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
    },
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function init(root: string, format: "sha1" | "sha256" = "sha1"): Repository {
  const path = join(root, `repo-${format}`);
  run(root, ["git", "init", "--quiet", `--object-format=${format}`, path]);
  const oidLength = format === "sha256" ? 64 : 40;
  return { path, oidLength, zeroOid: "0".repeat(oidLength) };
}

function commit(repo: Repository, content: string, name = "file.txt"): string {
  writeFileSync(join(repo.path, name), content);
  run(repo.path, ["git", "add", name]);
  run(repo.path, ["git", "commit", "--quiet", "-m", `update ${name}`]);
  return run(repo.path, ["git", "rev-parse", "HEAD"]);
}

function invoke(repo: Repository, input: string, remote = "origin", location = "fixture"): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [hook, remote, location], {
    cwd: repo.path,
    encoding: "utf8",
    input,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
}

test("empty input and deletions succeed without inspecting the worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "pre-push-empty-"));
  try {
    const repo = init(root);
    const base = commit(repo, "base\n");
    const first = commit(repo, "clean\n");
    writeFileSync(join(repo.path, "file.txt"), "dirty worktree line   \n");
    assert.equal(invoke(repo, "").status, 0);
    const update = `refs/heads/main ${first} refs/heads/main ${base}\n`;
    assert.equal(invoke(repo, update).status, 0);
    const deletion = `(delete) ${repo.zeroOid} refs/heads/main ${first}\n`;
    assert.equal(invoke(repo, deletion).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed hook reports a missing Node runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "pre-push-installer-"));
  try {
    const repo = init(root);
    const verifyDir = join(repo.path, "scripts/verify");
    const bin = join(root, "bin");
    mkdirSync(verifyDir, { recursive: true });
    mkdirSync(bin);
    copyFileSync(installer, join(verifyDir, "install-pre-push-hook.sh"));
    copyFileSync(hook, join(verifyDir, "pre-push.ts"));
    symlinkSync("/usr/bin/git", join(bin, "git"));
    symlinkSync("/usr/bin/false", join(bin, "node"));

    const install = spawnSync("/bin/bash", [join(verifyDir, "install-pre-push-hook.sh")], {
      cwd: repo.path,
      encoding: "utf8",
      env: process.env,
    });
    assert.equal(install.status, 0, install.stderr);

    const result = spawnSync("/bin/bash", [join(repo.path, ".git/hooks/pre-push"), "origin", "fixture"], {
      cwd: repo.path,
      encoding: "utf8",
      env: { ...process.env, PATH: bin },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing node; run mise install .* before pushing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing, new, and multiple ref updates inspect only outgoing commits", () => {
  const root = mkdtempSync(join(tmpdir(), "pre-push-updates-"));
  try {
    const repo = init(root);
    const base = commit(repo, "base\n");
    const clean = commit(repo, "clean\n");
    let input = `refs/heads/main ${clean} refs/heads/main ${base}\n`;
    assert.equal(invoke(repo, input).status, 0);

    const bad = commit(repo, "trailing whitespace   \n", "bad.txt");
    input = `refs/heads/topic ${bad} refs/heads/topic ${repo.zeroOid}\n`;
    const badResult = invoke(repo, input);
    assert.equal(badResult.status, 1);
    assert.match(badResult.stderr, /trailing whitespace/);

    input = [
      `refs/heads/main ${clean} refs/heads/main ${base}`,
      `refs/heads/topic ${bad} refs/heads/topic ${repo.zeroOid}`,
    ].join("\n");
    assert.equal(invoke(repo, `${input}\n`).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("URL remotes and repositories without tracking refs check new history", () => {
  const root = mkdtempSync(join(tmpdir(), "pre-push-url-"));
  try {
    const repo = init(root);
    const bad = commit(repo, "bad   \n");
    const input = `refs/heads/main ${bad} refs/heads/main ${repo.zeroOid}\n`;
    assert.equal(invoke(repo, input, "file:///missing.git", "file:///missing.git").status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing required objects fail with an actionable diagnostic", () => {
  const root = mkdtempSync(join(tmpdir(), "pre-push-missing-"));
  try {
    const repo = init(root);
    const local = commit(repo, "clean\n");
    const missing = "f".repeat(repo.oidLength);
    const localMissing = `refs/heads/main ${missing} refs/heads/main ${repo.zeroOid}\n`;
    assert.match(invoke(repo, localMissing).stderr, /missing local object/);
    const remoteMissing = `refs/heads/main ${local} refs/heads/main ${missing}\n`;
    assert.match(invoke(repo, remoteMissing).stderr, /missing remote commit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shallow repositories can verify commits above the shallow boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "pre-push-shallow-"));
  try {
    const source = init(root);
    commit(source, "base\n");
    const remotePath = join(root, "remote.git");
    run(root, ["git", "clone", "--quiet", "--bare", source.path, remotePath]);
    const shallowPath = join(root, "shallow");
    run(root, ["git", "clone", "--quiet", "--depth=1", `file://${remotePath}`, shallowPath]);
    const format = run(shallowPath, ["git", "rev-parse", "--show-object-format"]);
    assert.ok(format === "sha1" || format === "sha256");
    const shallow: Repository = {
      path: shallowPath,
      oidLength: format === "sha256" ? 64 : 40,
      zeroOid: "0".repeat(format === "sha256" ? 64 : 40),
    };
    const remoteOid = run(shallow.path, ["git", "rev-parse", "HEAD"]);
    const localOid = commit(shallow, "next\n");
    const input = `refs/heads/main ${localOid} refs/heads/main ${remoteOid}\n`;
    assert.equal(invoke(shallow, input, "origin", remotePath).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mirror-shaped non-commit and deletion updates are ignored safely", () => {
  const root = mkdtempSync(join(tmpdir(), "pre-push-mirror-"));
  try {
    const repo = init(root);
    const commitOid = commit(repo, "clean\n");
    const blobOid = run(repo.path, ["git", "hash-object", "file.txt"]);
    const input = [
      `refs/heads/main ${commitOid} refs/heads/main ${repo.zeroOid}`,
      `refs/custom/blob ${blobOid} refs/custom/blob ${repo.zeroOid}`,
      `(delete) ${repo.zeroOid} refs/heads/old ${commitOid}`,
    ].join("\n");
    assert.equal(invoke(repo, `${input}\n`).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SHA-256 object IDs are supported when Git supports them", (context) => {
  const root = mkdtempSync(join(tmpdir(), "pre-push-sha256-"));
  try {
    const probe = spawnSync("git", ["init", "--quiet", "--object-format=sha256", join(root, "probe")]);
    if (probe.status !== 0) {
      context.skip("installed Git does not support SHA-256 repositories");
      return;
    }
    rmSync(join(root, "probe"), { recursive: true, force: true });
    const repo = init(root, "sha256");
    const oid = commit(repo, "clean\n");
    const input = `refs/heads/main ${oid} refs/heads/main ${repo.zeroOid}\n`;
    assert.equal(invoke(repo, input).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
