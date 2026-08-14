import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceDir = join(repoRoot, "chezmoi");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function createFixture(): { config: string; home: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-agents-local-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const config = join(root, "chezmoi.toml");
  mkdirSync(home, { recursive: true });
  writeFileSync(config, "");
  return { config, home, root };
}

function runChezmoiResult(
  home: string,
  config: string,
  command: "apply" | "diff",
  source = sourceDir,
  profile = "workstation",
) {
  const args = [
    "--config",
    config,
    "--source",
    source,
    "--destination",
    home,
    "--override-data",
    JSON.stringify({ dotfilesProfile: profile }),
  ];
  if (command === "apply") {
    args.push("--force");
  }
  args.push(command);

  return spawnSync("chezmoi", args, {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"),
    },
  });
}

function runChezmoi(
  home: string,
  config: string,
  command: "apply" | "diff",
  source = sourceDir,
  profile = "workstation",
): string {
  const result = runChezmoiResult(home, config, command, source, profile);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function runWrapperResult(home: string, profile = "workstation") {
  return spawnSync(join(repoRoot, "scripts/bootstrap/apply-dotfiles.sh"), ["--profile", profile], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"),
    },
  });
}

function runWrapper(home: string, profile = "workstation"): string {
  const result = runWrapperResult(home, profile);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function assertManagedRules(home: string): string {
  const rules = join(home, "AGENTS.md");
  assert.equal(lstatSync(rules).isFile(), true);
  assert.equal(lstatSync(rules).mode & 0o777, 0o600);
  assert.equal(lstatSync(join(home, ".claude/CLAUDE.md")).isSymbolicLink(), true);
  assert.equal(lstatSync(join(home, ".codex/AGENTS.md")).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(home, ".claude/CLAUDE.md")), "../AGENTS.md");
  assert.equal(readlinkSync(join(home, ".codex/AGENTS.md")), "../AGENTS.md");
  return readFileSync(rules, "utf8");
}

test("applies public rules and links without private output", () => {
  const { config, home } = createFixture();

  runChezmoi(home, config, "apply");
  const rules = assertManagedRules(home);

  assert.match(rules, /^## General Guidelines/);
  assert.doesNotMatch(rules, /private fixture rule/);
  assert.match(rules, /Extend the closest structured owner instead\s+of creating a parallel script/);
  assert.match(rules, /#### Design and implementation/);
  assert.match(rules, /Create a pull request only when requested or required/);
  assert.match(rules, /If declined, explain why with evidence\.\n$/);
  assert.equal(runChezmoi(home, config, "diff"), "");
  runChezmoi(home, config, "apply");
  assert.equal(runChezmoi(home, config, "diff"), "");
});

test("omits global rules for workload profiles", () => {
  for (const profile of ["assistant", "service"]) {
    const { config, home } = createFixture();
    runChezmoi(home, config, "apply", sourceDir, profile);

    assert.equal(lstatSync(home).isDirectory(), true);
    assert.equal(readdirSync(home).includes("AGENTS.md"), false);
    assert.equal(readdirSync(home).includes(".agents"), false);
    assert.equal(readdirSync(home).includes(".claude"), false);
    assert.equal(readdirSync(home).includes(".codex"), false);
  }
});

test("reads an optional private end layer from machine-local Markdown", () => {
  const { home } = createFixture();
  const privateEnd = join(home, ".config/dotfiles/agents.end.md");
  mkdirSync(dirname(privateEnd), { recursive: true });
  writeFileSync(privateEnd, "## Private fixture rule\n\nKeep this fixture local.\n");
  chmodSync(privateEnd, 0o600);

  runWrapper(home);

  assert.match(
    assertManagedRules(home),
    /evidence\.\n\n## Private fixture rule\n\nKeep this fixture local\.\n$/,
  );
});

test("composes optional private Markdown around the shared rules", () => {
  const { home } = createFixture();
  const privateStart = join(home, ".config/dotfiles/agents.start.md");
  const privateEnd = join(home, ".config/dotfiles/agents.end.md");
  mkdirSync(dirname(privateStart), { recursive: true });
  writeFileSync(privateStart, "# Private fixture context\n\nLoad this first.\n");
  writeFileSync(privateEnd, "## Private fixture end\n\nLoad this last.\n");
  chmodSync(privateStart, 0o600);
  chmodSync(privateEnd, 0o600);

  runWrapper(home);
  const rules = assertManagedRules(home);

  assert.match(rules, /^# Private fixture context\n\nLoad this first\.\n\n## General Guidelines/);
  assert.ok(rules.indexOf("# Private fixture context") < rules.indexOf("## General Guidelines"));
  assert.ok(rules.indexOf("## General Guidelines") < rules.indexOf("## Private fixture end"));
  assert.match(rules, /## Private fixture end\n\nLoad this last\.\n$/);
});

test("reads machine-local Markdown through a symlink", () => {
  const { home, root } = createFixture();
  const privateEnd = join(home, ".config/dotfiles/agents.end.md");
  const externalEnd = join(root, "private/agents.end.md");
  mkdirSync(dirname(privateEnd), { recursive: true });
  mkdirSync(dirname(externalEnd), { recursive: true });
  writeFileSync(externalEnd, "## Symlinked fixture rule\n");
  chmodSync(externalEnd, 0o600);
  symlinkSync(externalEnd, privateEnd);

  runWrapper(home);

  assert.match(assertManagedRules(home), /## Symlinked fixture rule\n$/);
});

test("omits the private end layer for blank Markdown", () => {
  const { home } = createFixture();
  const privateEnd = join(home, ".config/dotfiles/agents.end.md");
  mkdirSync(dirname(privateEnd), { recursive: true });
  writeFileSync(privateEnd, " \n\t\n");
  chmodSync(privateEnd, 0o600);

  runWrapper(home);

  assert.match(assertManagedRules(home), /evidence\.\n$/);
});

test("ignores the retired agents.local.md path", () => {
  const { home } = createFixture();
  const retiredRules = join(home, ".config/dotfiles/agents.local.md");
  mkdirSync(dirname(retiredRules), { recursive: true });
  writeFileSync(retiredRules, "# Retired fixture rules\n");
  chmodSync(retiredRules, 0o600);

  runWrapper(home);

  assert.doesNotMatch(assertManagedRules(home), /Retired fixture rules/);
});

test("omits the private start layer for blank Markdown", () => {
  const { home } = createFixture();
  const privateStart = join(home, ".config/dotfiles/agents.start.md");
  mkdirSync(dirname(privateStart), { recursive: true });
  writeFileSync(privateStart, " \n\t\n");
  chmodSync(privateStart, 0o600);

  runWrapper(home);

  assert.match(assertManagedRules(home), /^## General Guidelines/);
});

test("shows rule changes in diff and waits for an explicit apply", () => {
  const { config, home, root } = createFixture();
  const source = join(root, "source");
  cpSync(sourceDir, source, { recursive: true });
  runChezmoi(home, config, "apply", source);
  const rulesPath = join(home, "AGENTS.md");
  const before = readFileSync(rulesPath, "utf8");

  appendFileSync(join(source, "private_AGENTS.md.tmpl"), "\nFixture public rule changed.\n");

  assert.match(runChezmoi(home, config, "diff", source), /Fixture public rule changed/);
  assert.equal(readFileSync(rulesPath, "utf8"), before);
  runChezmoi(home, config, "apply", source);
  assert.match(readFileSync(rulesPath, "utf8"), /Fixture public rule changed/);
  assert.equal(runChezmoi(home, config, "diff", source), "");
});

test("backs up a conflicting rule file before convergence", () => {
  const { home } = createFixture();
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/CLAUDE.md"), "unmanaged fixture rules\n");

  runWrapper(home);

  assertManagedRules(home);
  const backup = readdirSync(join(home, ".claude")).find((name) => name.startsWith("CLAUDE.md.backup."));
  assert.ok(backup);
  assert.equal(readFileSync(join(home, ".claude", backup), "utf8"), "unmanaged fixture rules\n");
});

test("backs up a conflicting home rule file before convergence", () => {
  const { home } = createFixture();
  writeFileSync(join(home, "AGENTS.md"), "unmanaged Cursor rules\n");

  runWrapper(home);

  assertManagedRules(home);
  const backup = readdirSync(home).find((name) => name.startsWith("AGENTS.md.backup."));
  assert.ok(backup);
  assert.equal(readFileSync(join(home, backup), "utf8"), "unmanaged Cursor rules\n");
});

test("backs up the retired rule file without removing installed skills", () => {
  const { home } = createFixture();
  const installedSkill = join(home, ".agents/skills/example/SKILL.md");
  mkdirSync(dirname(installedSkill), { recursive: true });
  writeFileSync(join(home, ".agents/AGENTS.md"), "retired shared rules\n");
  writeFileSync(installedSkill, "installed skill\n");

  runWrapper(home);

  assertManagedRules(home);
  assert.equal(readdirSync(join(home, ".agents")).includes("AGENTS.md"), false);
  const backup = readdirSync(join(home, ".agents")).find((name) => name.startsWith("AGENTS.md.backup."));
  assert.ok(backup);
  assert.equal(readFileSync(join(home, ".agents", backup), "utf8"), "retired shared rules\n");
  assert.equal(readFileSync(installedSkill, "utf8"), "installed skill\n");
});

test("backs up a broken rule link before convergence", () => {
  const { home } = createFixture();
  mkdirSync(join(home, ".codex"), { recursive: true });
  symlinkSync("../missing/AGENTS.md", join(home, ".codex/AGENTS.md"));

  runWrapper(home);

  assertManagedRules(home);
  const backup = readdirSync(join(home, ".codex")).find((name) => name.startsWith("AGENTS.md.backup."));
  assert.ok(backup);
  assert.equal(readlinkSync(join(home, ".codex", backup)), "../missing/AGENTS.md");
});

test("backs up a conflicting rule link before convergence", () => {
  const { home, root } = createFixture();
  const externalRules = join(root, "external/rules.md");
  mkdirSync(dirname(externalRules), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(externalRules, "external fixture rules\n");
  symlinkSync(externalRules, join(home, ".claude/CLAUDE.md"));
  symlinkSync(externalRules, join(home, ".codex/AGENTS.md"));

  runWrapper(home);

  assertManagedRules(home);
  for (const [directory, filename] of [[".claude", "CLAUDE.md"], [".codex", "AGENTS.md"]]) {
    const backup = readdirSync(join(home, directory)).find((name) => name.startsWith(`${filename}.backup.`));
    assert.ok(backup);
    assert.equal(readlinkSync(join(home, directory, backup)), externalRules);
  }
});

test("does not back up managed rule links again", () => {
  const { home } = createFixture();

  runWrapper(home);
  const output = runWrapper(home);

  assertManagedRules(home);
  assert.doesNotMatch(output, /backed up/);
  assert.equal(readdirSync(home).some((name) => name.startsWith("AGENTS.md.backup.")), false);
  assert.equal(readdirSync(join(home, ".claude")).some((name) => name.includes(".backup.")), false);
  assert.equal(readdirSync(join(home, ".codex")).some((name) => name.includes(".backup.")), false);
});

test("rejects local Markdown granting group or other access", () => {
  for (const name of ["agents.start.md", "agents.end.md"]) {
    for (const mode of [0o640, 0o604]) {
      const { home } = createFixture();
      const privateRules = join(home, ".config/dotfiles", name);
      mkdirSync(dirname(privateRules), { recursive: true });
      writeFileSync(privateRules, "### Permissive fixture rule\n");
      chmodSync(privateRules, mode);

      const result = runWrapperResult(home);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /local agent rules must not grant group or other access/);
    }
  }
});

test("rejects a broken local Markdown link", () => {
  for (const name of ["agents.start.md", "agents.end.md"]) {
    for (const profile of ["personal-workstation", "personal-devbox", "workstation", "devbox"]) {
      const { home } = createFixture();
      const privateRules = join(home, ".config/dotfiles", name);
      mkdirSync(dirname(privateRules), { recursive: true });
      symlinkSync(join(home, `missing-${name}`), privateRules);

      const result = runWrapperResult(home, profile);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /local agent rules link is broken/);
    }
  }
});

test("rejects local Markdown owned by another user", (context) => {
  if (process.getuid?.() === 0) {
    context.skip("requires a non-root test runner");
    return;
  }
  const { home } = createFixture();
  const privateRules = join(home, ".config/dotfiles/agents.end.md");
  mkdirSync(dirname(privateRules), { recursive: true });
  symlinkSync("/usr/bin/true", privateRules);

  const result = runWrapperResult(home);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /local agent rules must be owned by the current user/);
});

test("rejects a local Markdown symlink resolving to a directory", () => {
  for (const name of ["agents.start.md", "agents.end.md"]) {
    const { config, home, root } = createFixture();
    const privateRules = join(home, ".config/dotfiles", name);
    const directory = join(root, "private/rules");
    mkdirSync(dirname(privateRules), { recursive: true });
    mkdirSync(directory, { recursive: true });
    symlinkSync(directory, privateRules);

    const wrapperResult = runWrapperResult(home);
    const chezmoiResult = runChezmoiResult(home, config, "apply");

    assert.notEqual(wrapperResult.status, 0);
    assert.match(wrapperResult.stderr, /local agent rules must resolve to a regular file/);
    assert.notEqual(chezmoiResult.status, 0);
    assert.match(chezmoiResult.stderr, new RegExp(`${name.replaceAll(".", "\\.")} must resolve to a regular file`));
  }
});

test("ignores broken local Markdown links for workload profiles", () => {
  for (const name of ["agents.start.md", "agents.end.md"]) {
    for (const profile of ["assistant", "service"]) {
      const { home } = createFixture();
      const privateRules = join(home, ".config/dotfiles", name);
      mkdirSync(dirname(privateRules), { recursive: true });
      symlinkSync(join(home, `missing-${name}`), privateRules);

      runWrapper(home, profile);

      assert.equal(readdirSync(home).includes("AGENTS.md"), false);
    }
  }
});
