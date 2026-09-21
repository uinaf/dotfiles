import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const tools = `${read("chezmoi/.chezmoitemplates/mise.toml")}\n${read("chezmoi/.chezmoitemplates/mise-tasks.toml")}`;
const manifest = JSON.parse(read("package.json"));

function pin(source: string, pattern: RegExp): string {
  const match = pattern.exec(source);
  assert.ok(match?.[1], `missing pin: ${pattern}`);
  return match[1];
}

test("CI, bootstrap, and profile Node use the package engine floor", () => {
  const node = read(".node-version").trim();
  assert.match(node, /^\d+\.\d+\.\d+$/);
  assert.equal(pin(tools, /^node = "([^"]+)"/m), node);
  assert.equal(manifest.engines.node, `>=${node}`);
});

test("profile pnpm matches the repository package manager", () => {
  assert.equal(`pnpm@${pin(tools, /^pnpm = "([^"]+)"/m)}`, manifest.packageManager);
});

test("package convergence pins Corepack before disabling its pnpm shim", () => {
  const corepack = pin(tools, /npm install --global corepack@([\d.]+)/);
  assert.match(corepack, /^\d+\.\d+\.\d+$/);
  assert.ok(tools.indexOf(`corepack@${corepack}`) < tools.indexOf("corepack disable pnpm"));
});

test("PyYAML live verification follows its installation pin", () => {
  assert.equal(
    pin(read("verify/bootstrap.ts"), /const PYYAML_VERSION = "([^"]+)"/),
    pin(tools, /PyYAML==([\d.]+)/),
  );
});

test("Xcode pin is a dotted release consumed by the installer", () => {
  const xcode = JSON.parse(read("chezmoi/.chezmoidata/xcode.json")) as {
    version: number;
    release: string;
  };
  assert.equal(xcode.version, 1);
  assert.match(xcode.release, /^\d+\.\d+$/);
});

test("mise package convergence repeats without runtime installs and stops on failure", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-runtime-packages-"));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  // Keep the real task; runtime downloads are outside this fixture's scope.
  const task = tools.slice(tools.indexOf('[tasks."dotfiles:runtime-packages"]'));
  assert.ok(task.startsWith("[tasks."));
  writeFileSync(join(root, "mise.toml"), task);
  writeFileSync(join(root, "global.toml"), "");
  const log = join(root, "commands");
  for (const name of ["npm", "corepack", "python"]) {
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\nprintf '%s\\n' '${name}' >> "$TEST_LOG"\n[ '${name}' != "\${TEST_FAIL:-}" ]\n`,
      { mode: 0o755 },
    );
  }
  const run = (failure = "") =>
    spawnSync("mise", ["run", "dotfiles:runtime-packages"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        MISE_GLOBAL_CONFIG_FILE: join(root, "global.toml"),
        MISE_CONFIG_DIR: join(root, "config"),
        MISE_TRUSTED_CONFIG_PATHS: root,
        TEST_LOG: log,
        TEST_FAIL: failure,
      },
    });
  for (let i = 0; i < 2; i++) {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(readFileSync(log, "utf8"), "npm\nnpm\ncorepack\npython\n".repeat(2));
  writeFileSync(log, "");
  assert.notEqual(run("npm").status, 0);
  assert.equal(readFileSync(log, "utf8"), "npm\n");
});

test("mise and Renovate agree on CLI age exemptions without exempting runtimes or holds", () => {
  const source = read("chezmoi/private_dot_config/mise/config.toml.tmpl");
  const settings = source.slice(source.indexOf("[settings]"), source.indexOf("[settings.github]"));
  const parsed = spawnSync(
    "python3",
    [
      "-c",
      "import sys,tomllib,json; print(json.dumps(tomllib.loads(sys.stdin.read())['settings']))",
    ],
    { input: settings, encoding: "utf8" },
  );
  assert.equal(parsed.status, 0, parsed.stderr);
  const mise = JSON.parse(parsed.stdout);
  const renovate = JSON.parse(read("renovate.json"));
  const cliRule = renovate.packageRules.find(
    (rule: { groupName?: string }) => rule.groupName === "mise CLI patch and minor",
  );
  assert.ok(cliRule);
  assert.deepEqual(mise.minimum_release_age_excludes, cliRule.matchDepNames);
  assert.equal(mise.minimum_release_age, "24h");
  assert.equal(cliRule.minimumReleaseAge, null);
  assert.deepEqual(cliRule.matchUpdateTypes, ["patch", "minor", "pin"]);
  for (const tool of [
    "node",
    "bun",
    "python",
    "java",
    "ruby",
    "go",
    "uv",
    "pnpm",
    "npm:@playwright/cli",
  ]) {
    assert.ok(!mise.minimum_release_age_excludes.includes(tool), `${tool} retains its age gate`);
  }
});
