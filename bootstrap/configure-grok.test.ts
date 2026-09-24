import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readlinkSync,
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

// A fake mise reports the pinned install; its launcher stages like Grok's.
function pin(root: string, version?: string) {
  const bin = join(root, "bin");
  const install = join(root, "install");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "mise"),
    version === undefined
      ? "#!/bin/sh\necho 'mise ERROR npm:@xai-official/grok@1.0.1 not installed' >&2\nexit 1\n"
      : `#!/bin/sh\nprintf '%s\\n' '${install}'\n`,
    { mode: 0o755 },
  );
  if (version !== undefined) {
    mkdirSync(join(install, "node_modules/@xai-official/grok"), { recursive: true });
    mkdirSync(join(install, "node_modules/.bin"), { recursive: true });
    writeFileSync(
      join(install, "node_modules/@xai-official/grok/package.json"),
      JSON.stringify({ version }),
    );
    writeFileSync(
      join(install, "node_modules/.bin/grok"),
      `#!/bin/sh\necho launched >> '${join(root, "launches")}'\nmkdir -p "$GROK_HOME/bin"\n[ -e "$GROK_HOME/bin/grok" ] || { : > "$GROK_HOME/bin/grok-${version}"; ln -s grok-${version} "$GROK_HOME/bin/grok"; }\necho "grok $(readlink "$GROK_HOME/bin/grok" | sed s/^grok-//) (fixture) [stable]"\n`,
      { mode: 0o755 },
    );
  }
  return bin;
}

function run(home: string, bin?: string) {
  return spawnSync(script, ["--profile", "workstation"], {
    encoding: "utf8",
    env: {
      ...process.env,
      GROK_HOME: home,
      PATH: `${bin ?? pin(dirname(home))}:${process.env.PATH}`,
    },
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

test("a stale staged binary is replaced by the pinned version once", () => {
  const { root, home } = fixture();
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "bin/grok-1.0.0"), "");
  symlinkSync("grok-1.0.0", join(home, "bin/grok"));
  const bin = pin(root, "1.0.1");
  const first = run(home, bin);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^ok Grok runs the pinned 1\.0\.1$/m);
  assert.equal(readlinkSync(join(home, "bin/grok")), "grok-1.0.1");
  const second = run(home, bin);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(join(root, "launches"), "utf8"), "launched\n");
});

test("a missing pin leaves staged binaries alone", () => {
  const { root, home } = fixture();
  mkdirSync(join(home, "bin"), { recursive: true });
  symlinkSync("grok-1.0.0", join(home, "bin/grok"));
  const result = run(home, pin(root));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /skipping binary alignment/);
  assert.equal(readlinkSync(join(home, "bin/grok")), "grok-1.0.0");
  assert.equal(existsSync(join(root, "launches")), false);
});

test("other mise failures stop setup instead of skipping alignment", () => {
  const { root, home } = fixture();
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "mise"),
    "#!/bin/sh\necho 'mise ERROR config is untrusted' >&2\nexit 1\n",
    {
      mode: 0o755,
    },
  );
  const result = run(home, bin);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not resolve the Grok pin: mise ERROR config is untrusted/);
});

test("a launcher that stages a different version fails setup", () => {
  const { root, home } = fixture();
  const bin = pin(root, "1.0.1");
  writeFileSync(
    join(root, "install/node_modules/@xai-official/grok/package.json"),
    JSON.stringify({ version: "1.0.2" }),
  );
  const result = run(home, bin);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pinned Grok 1\.0\.2 did not stage: grok 1\.0\.1/);
});
