import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vite-plus/test";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "configure-grok.ts");
const grokInstalled = spawnSync("grok", ["--version"], { stdio: "ignore" }).status === 0;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-grok-config-"));
  roots.push(root);
  const home = join(root, "grok");
  return { root, home, config: join(home, "config.toml") };
}

function run(home: string) {
  return spawnSync(script, ["--profile", "workstation"], {
    encoding: "utf8",
    env: { ...process.env, GROK_HOME: home },
  });
}

test("Grok defaults are written owner-only and rewritten only on drift", () => {
  const { home, config } = fixture();
  mkdirSync(home);
  writeFileSync(config, '[cli]\nauto_update = true\n\n[ui]\ntheme = "groknight"\n', {
    mode: 0o644,
  });
  const first = run(home);
  assert.equal(first.status, 0, first.stderr);
  const contents = readFileSync(config, "utf8");
  assert.match(contents, /^auto_update = false$/m);
  assert.match(contents, /^theme = "groknight"$/m);
  assert.equal(statSync(config).mode & 0o777, 0o600);
  const mtime = statSync(config, { bigint: true }).mtimeNs;
  const second = run(home);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /^ok Grok defaults/m);
  assert.equal(statSync(config, { bigint: true }).mtimeNs, mtime);
});

test("a linked Grok config is refused and left untouched", () => {
  const { root, home, config } = fixture();
  mkdirSync(home);
  const target = join(root, "elsewhere.toml");
  writeFileSync(target, "[cli]\nauto_update = true\n");
  symlinkSync(target, config);
  const result = run(home);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be a regular file/);
  assert.equal(readFileSync(target, "utf8"), "[cli]\nauto_update = true\n");
});

test("installed Grok recognizes every managed key", { skip: !grokInstalled }, () => {
  const { root, home } = fixture();
  const result = run(home);
  assert.equal(result.status, 0, result.stderr);
  const inspect = spawnSync("grok", ["inspect", "--json"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GROK_HOME: home },
    timeout: 60_000,
  });
  assert.equal(inspect.status, 0, inspect.stderr);
  const { configWarnings } = JSON.parse(inspect.stdout) as {
    configWarnings?: { path: string }[];
  };
  assert.deepEqual(configWarnings ?? [], []);
});
