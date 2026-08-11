import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
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
  const root = mkdtempSync(join(tmpdir(), "dotfiles-agent-rules-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const config = join(root, "chezmoi.toml");
  mkdirSync(home, { recursive: true });
  writeFileSync(config, "");
  return { config, home, root };
}

function runChezmoi(
  home: string,
  config: string,
  command: "apply" | "diff",
  source = sourceDir,
  profile = "workstation",
): string {
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

  const result = spawnSync("chezmoi", args, {
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
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function runWrapper(home: string): string {
  const result = spawnSync(join(repoRoot, "scripts/bootstrap/apply-dotfiles.sh"), ["--profile", "workstation"], {
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
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function assertManagedRules(home: string): string {
  const rules = join(home, ".agents/AGENTS.md");
  assert.equal(lstatSync(rules).isFile(), true);
  assert.equal(lstatSync(join(home, "AGENTS.md")).isSymbolicLink(), true);
  assert.equal(lstatSync(join(home, ".claude/CLAUDE.md")).isSymbolicLink(), true);
  assert.equal(lstatSync(join(home, ".codex/AGENTS.md")).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(home, "AGENTS.md")), ".agents/AGENTS.md");
  assert.equal(readlinkSync(join(home, ".claude/CLAUDE.md")), "../.agents/AGENTS.md");
  assert.equal(readlinkSync(join(home, ".codex/AGENTS.md")), "../.agents/AGENTS.md");
  return readFileSync(rules, "utf8");
}

test("applies public rules and links without private output", () => {
  const { config, home } = createFixture();

  runChezmoi(home, config, "apply");
  const rules = assertManagedRules(home);

  assert.match(rules, /^# Agent Guidelines/);
  assert.doesNotMatch(rules, /Local Overrides|private fixture rule/);
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

test("reads an optional private layer from machine-local chezmoi data", () => {
  const { config, home } = createFixture();
  writeFileSync(
    config,
    '[data]\nagentRulesPrivate = """\n### Private fixture rule\n\nKeep this fixture local.\n"""\n',
  );

  runChezmoi(home, config, "apply");

  assert.match(assertManagedRules(home), /## Local Overrides\n\n### Private fixture rule/);
});

test("shows rule changes in diff and waits for an explicit apply", () => {
  const { config, home, root } = createFixture();
  const source = join(root, "source");
  cpSync(sourceDir, source, { recursive: true });
  runChezmoi(home, config, "apply", source);
  const rulesPath = join(home, ".agents/AGENTS.md");
  const before = readFileSync(rulesPath, "utf8");

  appendFileSync(join(source, "private_dot_agents/AGENTS.md.tmpl"), "\nFixture public rule changed.\n");

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

test("rejects a non-string private rule layer", () => {
  const { config, home } = createFixture();
  writeFileSync(config, "[data]\nagentRulesPrivate = true\n");
  const result = spawnSync(
    "chezmoi",
    [
      "--config",
      config,
      "--source",
      sourceDir,
      "--destination",
      home,
      "--override-data",
      '{"dotfilesProfile":"workstation"}',
      "apply",
    ],
    { encoding: "utf8", env: { ...process.env, HOME: home } },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /agentRulesPrivate must be a string/);
});
