import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "apply-dotfiles.ts");

test("a failed bootstrap tool provision reports the mise error", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-apply-provision-"));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const home = join(root, "home");
  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(
    join(bin, "mise"),
    "#!/bin/sh\nprintf 'mise ERROR fixture download failed\\n' >&2\nexit 1\n",
    { mode: 0o755 },
  );
  const result = spawnSync(process.execPath, [script, "--profile", "developer"], {
    encoding: "utf8",
    env: {
      HOME: home,
      DOTFILES_AGENT_RULES_OFFLINE: "1",
      PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /FAILED: cannot provision chezmoi@\S+ through mise \(exit 1\): mise ERROR fixture download failed/,
  );
});

test("a failed chezmoi query reports its stderr", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-apply-chezmoi-"));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const home = join(root, "home");
  mkdirSync(bin);
  mkdirSync(join(home, ".local/state/dotfiles"), { recursive: true });
  writeFileSync(
    join(home, ".local/state/dotfiles/agent-rules.md"),
    "## General guidelines\n\nFixture rule.\n",
    {
      mode: 0o600,
    },
  );
  writeFileSync(
    join(bin, "chezmoi"),
    "#!/bin/sh\nprintf 'chezmoi: fixture template error\\n' >&2\nexit 1\n",
    { mode: 0o755 },
  );
  const result = spawnSync(process.execPath, [script, "--profile", "developer"], {
    encoding: "utf8",
    env: {
      HOME: home,
      DOTFILES_AGENT_RULES_OFFLINE: "1",
      PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /FAILED: chezmoi managed exited 1: chezmoi: fixture template error/);
});

test("chezmoi applies with a 022 umask whatever the caller's", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-apply-umask-"));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const recorded = join(root, "umask");
  mkdirSync(bin);
  mkdirSync(join(home, ".local/state/dotfiles"), { recursive: true });
  writeFileSync(
    join(home, ".local/state/dotfiles/agent-rules.md"),
    "## General guidelines\n\nFixture rule.\n",
    { mode: 0o600 },
  );
  writeFileSync(
    join(bin, "chezmoi"),
    `#!/bin/sh\nfor arg; do [ "$arg" = apply ] && { umask > ${JSON.stringify(recorded)}; exit 1; }; done\nexit 0\n`,
    { mode: 0o755 },
  );
  const result = spawnSync(
    "/bin/sh",
    ["-c", 'umask 002; exec "$@"', "sh", process.execPath, script, "--profile", "developer"],
    {
      encoding: "utf8",
      env: {
        HOME: home,
        DOTFILES_AGENT_RULES_OFFLINE: "1",
        PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      },
    },
  );
  assert.match(result.stderr, /FAILED: chezmoi exited 1/);
  assert.equal(readFileSync(recorded, "utf8").trim(), "0022");
});
