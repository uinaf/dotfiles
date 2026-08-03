import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { main, type Runtime } from "./sync.ts";

type CommandCall = {
  command: string;
  args: readonly string[];
};

type FixtureOptions = {
  branch?: string;
  commonDir?: string;
  falseSuccesses?: ReadonlySet<string>;
  failures?: ReadonlyMap<string, FixtureFailure>;
  gitDir?: string;
  head?: string;
  removalFailures?: ReadonlyMap<string, FixtureFailure>;
  trackedChanges?: string;
  upstream?: string;
};

type FixtureFailure = {
  stderr: string;
  stdout: string;
};

class BufferWriter {
  value = "";

  write(message: string): void {
    this.value += message;
  }
}

class FixtureRuntime implements Runtime {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout = new BufferWriter();
  readonly stderr = new BufferWriter();
  readonly calls: CommandCall[] = [];
  readonly installedCommands = new Set(["claude", "codex"]);
  readonly branch: string;
  readonly commonDir: string;
  readonly falseSuccesses: ReadonlySet<string>;
  readonly failures: ReadonlyMap<string, FixtureFailure>;
  readonly gitDir: string;
  readonly head: string;
  readonly home: string;
  readonly repoDir: string;
  readonly removalFailures: ReadonlyMap<string, FixtureFailure>;
  readonly trackedChanges: string;
  readonly upstream: string;

  constructor(repoDir: string, home: string, options: FixtureOptions = {}) {
    this.repoDir = repoDir;
    this.removalFailures = options.removalFailures ?? new Map();
    this.branch = options.branch ?? "main";
    this.commonDir = options.commonDir ?? ".git";
    this.falseSuccesses = options.falseSuccesses ?? new Set();
    this.failures = options.failures ?? new Map();
    this.gitDir = options.gitDir ?? ".git";
    this.head = options.head ?? "same-head";
    this.home = home;
    this.trackedChanges = options.trackedChanges ?? "";
    this.upstream = options.upstream ?? this.head;
    this.env = { HOME: home, SKILLS_CLI_VERSION: "test-version" };
  }

  commandExists(command: string): boolean {
    return this.installedCommands.has(command);
  }

  run(command: string, args: readonly string[]): { status: number; stdout: string; stderr: string } {
    this.calls.push({ command, args });

    if (command === "git" && args.includes("rev-parse")) {
      if (args.includes("--show-toplevel")) {
        return { status: 0, stdout: `${this.repoDir}\n`, stderr: "" };
      }
      if (args.includes("--git-dir")) {
        return { status: 0, stdout: `${this.gitDir}\n`, stderr: "" };
      }
      if (args.includes("--git-common-dir")) {
        return { status: 0, stdout: `${this.commonDir}\n`, stderr: "" };
      }
      if (args.includes("--abbrev-ref")) {
        return { status: 0, stdout: `${this.branch}\n`, stderr: "" };
      }
      if (args.includes("@{upstream}")) {
        return { status: 0, stdout: `${this.upstream}\n`, stderr: "" };
      }
      if (args.includes("HEAD")) {
        return { status: 0, stdout: `${this.head}\n`, stderr: "" };
      }
      return { status: 99, stdout: "", stderr: `Unexpected git rev-parse: ${args.join(" ")}` };
    }
    if (command === "git" && args.includes("status")) {
      return { status: 0, stdout: this.trackedChanges, stderr: "" };
    }
    if (command === "git" && args.includes("pull")) {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "pnpm" && args[0] === "dlx" && args[2] === "add") {
      const skillFlag = args.indexOf("-s");
      const skill = skillFlag >= 0 ? args[skillFlag + 1] : undefined;
      if (skill === undefined) {
        throw new Error("skills installer call must include -s <name>");
      }
      const diagnostic = this.failures.get(skill);
      if (diagnostic !== undefined) {
        return { status: 1, stdout: diagnostic.stdout, stderr: diagnostic.stderr };
      }
      if (!this.falseSuccesses.has(skill)) {
        const skillDir = join(this.home, ".agents", "skills", skill);
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${skill}\ndescription: Fixture\n---\n`);
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "pnpm" && args[0] === "dlx" && args[2] === "remove") {
      const skillFlag = args.indexOf("-s");
      const skill = skillFlag >= 0 ? args[skillFlag + 1] : undefined;
      if (skill === undefined) {
        throw new Error("skills remover call must include -s <name>");
      }
      const diagnostic = this.removalFailures.get(skill);
      if (diagnostic !== undefined) {
        return { status: 1, stdout: diagnostic.stdout, stderr: diagnostic.stderr };
      }
      rmSync(join(this.home, ".agents", "skills", skill), { force: true, recursive: true });
      return { status: 0, stdout: "", stderr: "" };
    }

    return { status: 99, stdout: "", stderr: `Unexpected command: ${command}` };
  }
}

const temporaryDirectories: string[] = [];

const fixtureSkills = [
  { name: "ok-before", source: "fixture/before" },
  { name: "fails-first", source: "fixture/failure-first" },
  { name: "ok-middle", source: "fixture/middle" },
  { name: "fails-second", source: "fixture/failure-second" },
  { name: "ok-after", source: "fixture/after" },
];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function createFixture(): { repoDir: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-agents-sync-"));
  temporaryDirectories.push(root);
  const repoDir = join(root, "repo");
  const home = join(root, "home");

  mkdirSync(join(repoDir, "scripts", "agents", "rules"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(repoDir, "scripts", "agents", "rules", "base.md"), "# Fixture agent rules\n");
  writeFileSync(
    join(repoDir, "scripts", "agents", "skills.json"),
    JSON.stringify(
      {
        skills: fixtureSkills,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(repoDir, "scripts", "agents", "skills.lock.json"),
    JSON.stringify({ version: 1, skills: fixtureSkills }, null, 2),
  );

  return { repoDir, home };
}

function installedSkillNames(runtime: FixtureRuntime): string[] {
  return runtime.calls
    .filter((call) => call.command === "pnpm" && call.args[0] === "dlx" && call.args[2] === "add")
    .map((call) => {
      const skillFlag = call.args.indexOf("-s");
      const skill = skillFlag >= 0 ? call.args[skillFlag + 1] : undefined;
      if (skill === undefined) {
        throw new Error("recorded skills installer call must include -s <name>");
      }
      return skill;
    });
}

function removedSkillNames(runtime: FixtureRuntime): string[] {
  return runtime.calls
    .filter(
      (call) => call.command === "pnpm" && call.args[0] === "dlx" && call.args[2] === "remove",
    )
    .map((call) => {
      const skillFlag = call.args.indexOf("-s");
      const skill = skillFlag >= 0 ? call.args[skillFlag + 1] : undefined;
      if (skill === undefined) {
        throw new Error("recorded skills remover call must include -s <name>");
      }
      return skill;
    });
}

function skillLockPath(repoDir: string): string {
  return join(repoDir, "scripts", "agents", "skills.lock.json");
}

function finalRulesPath(repoDir: string): string {
  return join(repoDir, "scripts", "agents", "rules", "final.md");
}

function createManagedRuleLinks(repoDir: string, home: string): void {
  const finalRules = finalRulesPath(repoDir);
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  symlinkSync(finalRules, join(home, ".claude", "CLAUDE.md"));
  symlinkSync(finalRules, join(home, ".codex", "AGENTS.md"));
}

test("reports every installer failure after attempting the full manifest", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, {
    failures: new Map([
      [
        "fails-first",
        {
          stdout: "installer token=stdout-secret",
          stderr: "npm error code E401\nnpm error token=stderr-secret",
        },
      ],
      ["fails-second", { stdout: "", stderr: "package source was not found" }],
    ]),
  });

  assert.equal(main([], runtime), 1);
  assert.deepEqual(installedSkillNames(runtime), [
    "ok-before",
    "fails-first",
    "ok-middle",
    "fails-second",
    "ok-after",
  ]);
  assert.match(runtime.stderr.value, /Skill installation failed for 2 skills:/);
  assert.match(runtime.stderr.value, /fails-first \(fixture\/failure-first, exit 1\)/);
  assert.match(runtime.stderr.value, /fails-second \(fixture\/failure-second, exit 1\)/);
  assert.match(runtime.stderr.value, /installer token=\[REDACTED\]/);
  assert.match(runtime.stderr.value, /npm error token=\[REDACTED\]/);
  assert.match(runtime.stderr.value, /package source was not found/);
  assert.doesNotMatch(runtime.stderr.value, /stdout-secret|stderr-secret/);
  assert.doesNotMatch(runtime.stdout.value, /Done\./);
});

test("rejects a false-success installer result when the installed artifact is missing", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, {
    falseSuccesses: new Set(["ok-middle"]),
  });

  assert.equal(main([], runtime), 1);
  assert.deepEqual(installedSkillNames(runtime), [
    "ok-before",
    "fails-first",
    "ok-middle",
    "fails-second",
    "ok-after",
  ]);
  assert.match(runtime.stderr.value, /ok-middle \(fixture\/middle, invalid installed artifact\)/);
  assert.match(runtime.stderr.value, /installer reported success but .*SKILL\.md is missing/);
  assert.doesNotMatch(runtime.stdout.value, /Done\./);
});

for (const scenario of [
  {
    name: "refuses a linked worktree before pulling or changing global state",
    options: { commonDir: "/tmp/agents/.git", gitDir: "/tmp/agents/.git/worktrees/feature" },
    message: /primary checkout, not a linked worktree/,
  },
  {
    name: "refuses a non-main branch before pulling or changing global state",
    options: { branch: "feature/sync" },
    message: /main branch; current branch is feature\/sync/,
  },
]) {
  test(scenario.name, () => {
    const { repoDir, home } = createFixture();
    const runtime = new FixtureRuntime(repoDir, home, scenario.options);

    assert.equal(main([], runtime), 1);
    assert.match(runtime.stderr.value, scenario.message);
    assert.equal(
      runtime.calls.some((call) => call.command === "git" && call.args.includes("pull")),
      false,
    );
    assert.equal(installedSkillNames(runtime).length, 0);
  });
}

for (const trackedChanges of ["M  scripts/agents/rules/base.md\n", " M scripts/agents/sync.ts\n"]) {
  test(`refuses tracked checkout dirt before pulling: ${trackedChanges.trim()}`, () => {
    const { repoDir, home } = createFixture();
    writeFileSync(finalRulesPath(repoDir), "existing generated rules\n");
    const runtime = new FixtureRuntime(repoDir, home, { trackedChanges });

    assert.equal(main([], runtime), 1);
    assert.match(runtime.stderr.value, /clean tracked checkout before pulling/);
    assert.ok(runtime.stderr.value.includes(trackedChanges.trim()));
    assert.equal(
      runtime.calls.some((call) => call.command === "git" && call.args.includes("pull")),
      false,
    );
    assert.equal(readFileSync(finalRulesPath(repoDir), "utf8"), "existing generated rules\n");
    assert.equal(installedSkillNames(runtime).length, 0);
  });
}

test("refuses a local main commit that is not published upstream", () => {
  const { repoDir, home } = createFixture();
  writeFileSync(finalRulesPath(repoDir), "existing generated rules\n");
  const runtime = new FixtureRuntime(repoDir, home, {
    head: "local-head",
    upstream: "upstream-head",
  });

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /Local main must exactly match its upstream after pulling/);
  assert.match(runtime.stderr.value, /local local-head, upstream upstream-head/);
  assert.equal(
    runtime.calls.some((call) => call.command === "git" && call.args.includes("pull")),
    true,
  );
  assert.equal(readFileSync(finalRulesPath(repoDir), "utf8"), "existing generated rules\n");
  assert.equal(installedSkillNames(runtime).length, 0);
});

test("completes a successful sync and preserves rules links", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home);
  runtime.env.SKILLS_CLI_VERSION = "";

  assert.equal(main([], runtime), 0);
  assert.match(runtime.stdout.value, /Done\./);
  assert.equal(
    runtime.calls.find((call) => call.command === "pnpm" && call.args[0] === "dlx")?.args[1],
    "skills@1.5.7",
  );
  assert.equal(
    readFileSync(join(repoDir, "scripts", "agents", "rules", "final.md"), "utf8"),
    "# Agent Instructions\n\n" +
      "Generated by scripts/agents/sync.ts from scripts/agents/rules/base.md and optional scripts/agents/rules/local.md. Do not edit directly.\n\n" +
      "---\n\n" +
      "# Fixture agent rules\n",
  );
  const finalRules = join(repoDir, "scripts", "agents", "rules", "final.md");
  assert.equal(readlinkSync(join(home, ".claude", "CLAUDE.md")), finalRules);
  assert.equal(readlinkSync(join(home, ".codex", "AGENTS.md")), finalRules);
});

test("initializes a missing ownership lock without removing unowned skills", () => {
  const { repoDir, home } = createFixture();
  rmSync(skillLockPath(repoDir));
  const unownedSkill = join(home, ".agents", "skills", "manual-skill");
  mkdirSync(unownedSkill, { recursive: true });
  writeFileSync(join(unownedSkill, "SKILL.md"), "manual skill\n");
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 0);
  assert.deepEqual(removedSkillNames(runtime), []);
  assert.equal(existsSync(unownedSkill), true);
  assert.deepEqual(
    JSON.parse(readFileSync(skillLockPath(repoDir), "utf8")),
    { version: 1, skills: fixtureSkills },
  );
  assert.match(runtime.stdout.value, /Initializing managed skills lock without removing existing skills/);
});

test("removes only skills dropped from the previous managed lock", () => {
  const { repoDir, home } = createFixture();
  const retiredSkill = { name: "retired-managed", source: "fixture/retired" };
  writeFileSync(
    skillLockPath(repoDir),
    JSON.stringify({ version: 1, skills: [...fixtureSkills, retiredSkill] }, null, 2),
  );
  const retiredDirectory = join(home, ".agents", "skills", retiredSkill.name);
  const unownedDirectory = join(home, ".agents", "skills", "manual-skill");
  mkdirSync(retiredDirectory, { recursive: true });
  mkdirSync(unownedDirectory, { recursive: true });
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 0);
  assert.deepEqual(removedSkillNames(runtime), [retiredSkill.name]);
  assert.equal(existsSync(retiredDirectory), false);
  assert.equal(existsSync(unownedDirectory), true);
  assert.deepEqual(
    JSON.parse(readFileSync(skillLockPath(repoDir), "utf8")),
    { version: 1, skills: fixtureSkills },
  );
});

test("does not prune or advance ownership when installation fails", () => {
  const { repoDir, home } = createFixture();
  const retiredSkill = { name: "retired-managed", source: "fixture/retired" };
  const previousLock = { version: 1, skills: [...fixtureSkills, retiredSkill] };
  writeFileSync(skillLockPath(repoDir), JSON.stringify(previousLock, null, 2));
  const retiredDirectory = join(home, ".agents", "skills", retiredSkill.name);
  mkdirSync(retiredDirectory, { recursive: true });
  const runtime = new FixtureRuntime(repoDir, home, {
    failures: new Map([["fails-first", { stdout: "", stderr: "install failed" }]]),
  });

  assert.equal(main([], runtime), 1);
  assert.deepEqual(removedSkillNames(runtime), []);
  assert.equal(existsSync(retiredDirectory), true);
  assert.deepEqual(JSON.parse(readFileSync(skillLockPath(repoDir), "utf8")), previousLock);
});

test("does not advance ownership when a managed removal fails", () => {
  const { repoDir, home } = createFixture();
  const retiredSkill = { name: "retired-managed", source: "fixture/retired" };
  const previousLock = { version: 1, skills: [...fixtureSkills, retiredSkill] };
  writeFileSync(skillLockPath(repoDir), JSON.stringify(previousLock, null, 2));
  const retiredDirectory = join(home, ".agents", "skills", retiredSkill.name);
  mkdirSync(retiredDirectory, { recursive: true });
  const runtime = new FixtureRuntime(repoDir, home, {
    removalFailures: new Map([
      [retiredSkill.name, { stdout: "", stderr: "remove failed" }],
    ]),
  });

  assert.equal(main([], runtime), 1);
  assert.deepEqual(removedSkillNames(runtime), [retiredSkill.name]);
  assert.equal(existsSync(retiredDirectory), true);
  assert.deepEqual(JSON.parse(readFileSync(skillLockPath(repoDir), "utf8")), previousLock);
  assert.match(runtime.stderr.value, /Managed skill removal failed for 1 skill/);
});

test("rejects unsafe ownership lock names before changing global state", () => {
  const { repoDir, home } = createFixture();
  writeFileSync(
    skillLockPath(repoDir),
    JSON.stringify({ version: 1, skills: [{ name: "../manual-skill", source: "fixture/unsafe" }] }),
  );
  const manualDirectory = join(home, ".agents", "manual-skill");
  mkdirSync(manualDirectory, { recursive: true });
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /Invalid managed skills lock/);
  assert.equal(installedSkillNames(runtime).length, 0);
  assert.equal(removedSkillNames(runtime).length, 0);
  assert.equal(existsSync(finalRulesPath(repoDir)), false);
  assert.equal(existsSync(manualDirectory), true);
});

test("includes ignored local overrides in generated rules", () => {
  const { repoDir, home } = createFixture();
  writeFileSync(
    join(repoDir, "scripts", "agents", "rules", "local.md"),
    "### Private machine override\n",
  );
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 0);
  assert.match(
    readFileSync(finalRulesPath(repoDir), "utf8"),
    /## Local Overrides\n\n### Private machine override/,
  );
  const statusCall = runtime.calls.find(
    (call) => call.command === "git" && call.args.includes("status"),
  );
  assert.deepEqual(statusCall?.args.slice(-2), ["--porcelain=v1", "--untracked-files=no"]);
});

test("migrates local overrides from the previous flat rule layout", () => {
  const { repoDir, home } = createFixture();
  const previousLocalRules = join(repoDir, "scripts", "agents", "rules.local.md");
  const localRules = join(repoDir, "scripts", "agents", "rules", "local.md");
  writeFileSync(previousLocalRules, "### Previous private machine override\n");
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 0);
  assert.equal(existsSync(previousLocalRules), false);
  assert.equal(readFileSync(localRules, "utf8"), "### Previous private machine override\n");
  assert.match(
    readFileSync(finalRulesPath(repoDir), "utf8"),
    /## Local Overrides\n\n### Previous private machine override/,
  );
  assert.match(
    runtime.stdout.value,
    /Migrated: scripts\/agents\/rules\.local\.md -> scripts\/agents\/rules\/local\.md/,
  );
});

test("rejects ambiguous local overrides before generating or linking rules", () => {
  const { repoDir, home } = createFixture();
  const previousLocalRules = join(repoDir, "scripts", "agents", "rules.local.md");
  const localRules = join(repoDir, "scripts", "agents", "rules", "local.md");
  writeFileSync(previousLocalRules, "### Previous override\n");
  writeFileSync(localRules, "### Current override\n");
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /Both .*rules\/local\.md and legacy .*rules\.local\.md exist/);
  assert.equal(existsSync(finalRulesPath(repoDir)), false);
  assert.equal(existsSync(join(home, ".claude", "CLAUDE.md")), false);
  assert.equal(existsSync(join(home, ".codex", "AGENTS.md")), false);
});

test("replaces links already managed by this sync target", () => {
  const { repoDir, home } = createFixture();
  writeFileSync(finalRulesPath(repoDir), "old generated rules\n");
  createManagedRuleLinks(repoDir, home);
  writeFileSync(
    join(repoDir, "scripts", "agents", "rules", "base.md"),
    "# Updated fixture agent rules\n",
  );
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 0);
  assert.match(readFileSync(finalRulesPath(repoDir), "utf8"), /# Updated fixture agent rules/);
  assert.equal(readlinkSync(join(home, ".claude", "CLAUDE.md")), finalRulesPath(repoDir));
  assert.equal(readlinkSync(join(home, ".codex", "AGENTS.md")), finalRulesPath(repoDir));
});

test("refuses every unmanaged global destination without partial mutation", () => {
  const { repoDir, home } = createFixture();
  writeFileSync(finalRulesPath(repoDir), "old generated rules\n");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "hand-written Claude rules\n");
  symlinkSync("../other/AGENTS.md", join(home, ".codex", "AGENTS.md"));
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /Refusing to replace unmanaged global agent rules/);
  assert.match(runtime.stderr.value, /\.claude\/CLAUDE\.md: it is not a symbolic link/);
  assert.match(runtime.stderr.value, /\.codex\/AGENTS\.md: it points to \.\.\/other\/AGENTS\.md/);
  assert.equal(readFileSync(finalRulesPath(repoDir), "utf8"), "old generated rules\n");
  assert.equal(
    readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8"),
    "hand-written Claude rules\n",
  );
  assert.equal(readlinkSync(join(home, ".codex", "AGENTS.md")), "../other/AGENTS.md");
  assert.equal(installedSkillNames(runtime).length, 0);
});

test("migrates links managed by the former agents checkout", () => {
  const { repoDir, home } = createFixture();
  const legacyRules = join(dirname(repoDir), "agents", "rules", "agents.final.md");
  mkdirSync(dirname(legacyRules), { recursive: true });
  writeFileSync(legacyRules, "legacy generated rules\n");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  symlinkSync(legacyRules, join(home, ".claude", "CLAUDE.md"));
  symlinkSync(legacyRules, join(home, ".codex", "AGENTS.md"));
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 0);
  assert.equal(readlinkSync(join(home, ".claude", "CLAUDE.md")), finalRulesPath(repoDir));
  assert.equal(readlinkSync(join(home, ".codex", "AGENTS.md")), finalRulesPath(repoDir));
});

test("migrates links and generated output from the previous flat rule layout", () => {
  const { repoDir, home } = createFixture();
  const previousFinalRules = join(repoDir, "scripts", "agents", "rules.final.md");
  writeFileSync(previousFinalRules, "previous generated rules\n");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  symlinkSync(previousFinalRules, join(home, ".claude", "CLAUDE.md"));
  symlinkSync(previousFinalRules, join(home, ".codex", "AGENTS.md"));
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 0);
  assert.equal(existsSync(previousFinalRules), false);
  assert.equal(readlinkSync(join(home, ".claude", "CLAUDE.md")), finalRulesPath(repoDir));
  assert.equal(readlinkSync(join(home, ".codex", "AGENTS.md")), finalRulesPath(repoDir));
});

test("rejects an invalid manifest before changing generated or global rules", () => {
  const { repoDir, home } = createFixture();
  writeFileSync(finalRulesPath(repoDir), "old generated rules\n");
  createManagedRuleLinks(repoDir, home);
  writeFileSync(
    join(repoDir, "scripts", "agents", "skills.json"),
    '{"skills":[{"name":"missing-source"}]}',
  );
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /Invalid skills manifest/);
  assert.match(runtime.stderr.value, /expected non-empty name\/source strings/);
  assert.equal(readFileSync(finalRulesPath(repoDir), "utf8"), "old generated rules\n");
  assert.equal(readlinkSync(join(home, ".claude", "CLAUDE.md")), finalRulesPath(repoDir));
  assert.equal(readlinkSync(join(home, ".codex", "AGENTS.md")), finalRulesPath(repoDir));
  assert.equal(installedSkillNames(runtime).length, 0);
});

test("uses the renamed first-party skill source", () => {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const manifest: unknown = JSON.parse(
    readFileSync(join(scriptDir, "skills.json"), "utf8"),
  );

  assert.ok(
    typeof manifest === "object" &&
      manifest !== null &&
      "skills" in manifest &&
      Array.isArray(manifest.skills),
  );

  const sources = manifest.skills.map((skill: unknown) => {
      assert.ok(
        typeof skill === "object" &&
          skill !== null &&
          "name" in skill &&
          typeof skill.name === "string" &&
          "source" in skill &&
          typeof skill.source === "string",
      );
      return skill.source;
    });

  assert.equal(sources.includes("uinaf/agents"), false);
  assert.equal(sources.includes("uinaf/skills"), true);
});

test("the executable TypeScript entrypoint runs the CLI", () => {
  const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "sync.ts");
  const result = spawnSync(scriptPath, ["unexpected"], { encoding: "utf8" });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: \.\/scripts\/agents\/sync\.ts/);
});
