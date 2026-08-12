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

  assert.match(rules, /^# Agent Guidelines/);
  assert.doesNotMatch(rules, /Local Overrides|private fixture rule/);
  assert.match(rules, /Keep each inline review comment to one actionable concern and short\n$/);
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

test("reads an optional private layer from machine-local Markdown", () => {
  const { home } = createFixture();
  const privateRules = join(home, ".config/dotfiles/agents.local.md");
  mkdirSync(dirname(privateRules), { recursive: true });
  writeFileSync(privateRules, "### Private fixture rule\n\nKeep this fixture local.\n");
  chmodSync(privateRules, 0o600);

  runWrapper(home);

  assert.match(assertManagedRules(home), /## Local Overrides\n\n### Private fixture rule/);
});

test("reads machine-local Markdown through a symlink", () => {
  const { home, root } = createFixture();
  const privateRules = join(home, ".config/dotfiles/agents.local.md");
  const externalRules = join(root, "private/agents.local.md");
  mkdirSync(dirname(privateRules), { recursive: true });
  mkdirSync(dirname(externalRules), { recursive: true });
  writeFileSync(externalRules, "### Symlinked fixture rule\n");
  chmodSync(externalRules, 0o600);
  symlinkSync(externalRules, privateRules);

  runWrapper(home);

  assert.match(assertManagedRules(home), /## Local Overrides\n\n### Symlinked fixture rule/);
});

test("omits local overrides for blank Markdown", () => {
  const { home } = createFixture();
  const privateRules = join(home, ".config/dotfiles/agents.local.md");
  mkdirSync(dirname(privateRules), { recursive: true });
  writeFileSync(privateRules, " \n\t\n");
  chmodSync(privateRules, 0o600);

  runWrapper(home);

  assert.doesNotMatch(assertManagedRules(home), /Local Overrides/);
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
  for (const mode of [0o640, 0o604]) {
    const { home } = createFixture();
    const privateRules = join(home, ".config/dotfiles/agents.local.md");
    mkdirSync(dirname(privateRules), { recursive: true });
    writeFileSync(privateRules, "### Permissive fixture rule\n");
    chmodSync(privateRules, mode);

    const result = runWrapperResult(home);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /local agent rules must not grant group or other access/);
  }
});

test("rejects a broken local Markdown link", () => {
  const { home } = createFixture();
  const privateRules = join(home, ".config/dotfiles/agents.local.md");
  mkdirSync(dirname(privateRules), { recursive: true });
  symlinkSync(join(home, "missing-agents.local.md"), privateRules);

  const result = runWrapperResult(home);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /local agent rules link is broken/);
});

test("rejects local Markdown owned by another user", () => {
  const { home } = createFixture();
  const privateRules = join(home, ".config/dotfiles/agents.local.md");
  mkdirSync(dirname(privateRules), { recursive: true });
  symlinkSync("/etc/master.passwd", privateRules);

  const result = runWrapperResult(home);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /local agent rules must be owned by the current user/);
});

test("rejects a local Markdown symlink resolving to a directory", () => {
  const { config, home, root } = createFixture();
  const privateRules = join(home, ".config/dotfiles/agents.local.md");
  const directory = join(root, "private/rules");
  mkdirSync(dirname(privateRules), { recursive: true });
  mkdirSync(directory, { recursive: true });
  symlinkSync(directory, privateRules);

  const wrapperResult = runWrapperResult(home);
  const chezmoiResult = runChezmoiResult(home, config, "apply");

  assert.notEqual(wrapperResult.status, 0);
  assert.match(wrapperResult.stderr, /local agent rules must resolve to a regular file/);
  assert.notEqual(chezmoiResult.status, 0);
  assert.match(chezmoiResult.stderr, /agents\.local\.md must resolve to a regular file/);
});

test("ignores broken local Markdown links for workload profiles", () => {
  for (const profile of ["assistant", "service"]) {
    const { home } = createFixture();
    const privateRules = join(home, ".config/dotfiles/agents.local.md");
    mkdirSync(dirname(privateRules), { recursive: true });
    symlinkSync(join(home, "missing-agents.local.md"), privateRules);

    runWrapper(home, profile);

    assert.equal(readdirSync(home).includes("AGENTS.md"), false);
  }
});
