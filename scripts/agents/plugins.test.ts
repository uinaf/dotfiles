import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { readProfileModel } from "../profiles/model.ts";
import { HARNESSES, main, planHarness, pluginRef, readLayeredPlugins, readPlugins } from "./plugins.ts";
import { type Runtime } from "./runtime.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const profileModel = readProfileModel(join(repoRoot, "chezmoi/.chezmoidata/profiles.json"));

type CommandCall = {
  command: string;
  args: readonly string[];
};

type FixtureFailure = {
  stderr: string;
  stdout: string;
};

type FixtureOptions = {
  failures?: ReadonlyMap<string, FixtureFailure>;
  outputs?: ReadonlyMap<string, string>;
  profile?: string;
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
  readonly installedCommands = new Set(["claude", "codex", "cursor-agent", "grok", "opencode"]);
  readonly failures: ReadonlyMap<string, FixtureFailure>;
  readonly outputs: ReadonlyMap<string, string>;
  readonly profile: string;
  readonly repoDir: string;

  constructor(repoDir: string, home: string, options: FixtureOptions = {}) {
    this.repoDir = repoDir;
    this.failures = options.failures ?? new Map();
    this.outputs = options.outputs ?? new Map();
    this.profile = options.profile ?? "workstation";
    this.env = { HOME: home };
  }

  commandExists(command: string): boolean {
    return this.installedCommands.has(command);
  }

  run(command: string, args: readonly string[]): { status: number; stdout: string; stderr: string } {
    this.calls.push({ command, args });

    if (command.endsWith("/resolve-profile.ts")) {
      const expectedFlag = args.indexOf("--expected");
      const expected = expectedFlag >= 0 ? args[expectedFlag + 1] : undefined;
      if (expected !== undefined && expected !== this.profile) {
        return { status: 3, stdout: "", stderr: "profile mismatch" };
      }
      if ((profileModel.profiles[this.profile]?.skillLayers.length ?? 0) === 0) {
        return { status: 3, stdout: "", stderr: "profile does not manage agents" };
      }
      return { status: 0, stdout: `${this.profile}\n`, stderr: "" };
    }

    const diagnostic = this.failures.get(`${command} ${args.join(" ")}`);
    if (diagnostic !== undefined) {
      return { status: 1, stdout: diagnostic.stdout, stderr: diagnostic.stderr };
    }
    return { status: 0, stdout: this.outputs.get(`${command} ${args.join(" ")}`) ?? "", stderr: "" };
  }
}

const temporaryDirectories: string[] = [];

const fixtureSharedPlugins = [
  { marketplace: "fixture/shared-market", name: "shared-plugin" },
  { marketplace: "fixture/shared-market", name: "second-plugin" },
];

const fixturePersonalPlugins = [
  { marketplace: "fixture/personal-market", name: "personal-plugin", harnesses: ["claude"] },
];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function createFixture(): { repoDir: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-agents-plugins-"));
  temporaryDirectories.push(root);
  const repoDir = join(root, "repo");
  const home = join(root, "home");

  mkdirSync(join(repoDir, "scripts", "agents", "plugins"), { recursive: true });
  mkdirSync(join(repoDir, "chezmoi", ".chezmoidata"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(repoDir, "chezmoi", ".chezmoidata", "profiles.json"),
    readFileSync(join(repoRoot, "chezmoi", ".chezmoidata", "profiles.json")),
  );
  writeManifest(repoDir, "developer", fixtureSharedPlugins);
  writeManifest(repoDir, "workstation", []);
  writeManifest(repoDir, "devbox", []);
  writeManifest(repoDir, "personal", fixturePersonalPlugins);
  writeClaudeCheckout(home, "shared-market", ["alpha", "beta"]);
  writeClaudeCheckout(home, "personal-market", ["gamma"]);

  return { repoDir, home };
}

function writeClaudeCheckout(home: string, marketplaceId: string, skills: readonly string[]): void {
  for (const skill of skills) {
    const skillDir = join(home, ".claude", "plugins", "marketplaces", marketplaceId, "skills", skill);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${skill}\n---\n`);
  }
}

function opencodeLink(home: string, skill: string): string {
  return join(home, ".config", "opencode", "skills", skill);
}

function cursorLink(home: string, skill: string): string {
  return join(home, ".cursor", "skills", skill);
}

function writeManifest(repoDir: string, layer: string, plugins: unknown): void {
  writeFileSync(
    join(repoDir, "scripts", "agents", "plugins", `${layer}.json`),
    JSON.stringify({ plugins }, null, 2),
  );
}

function manifestPath(repoDir: string, layer: string): string {
  return join(repoDir, "scripts", "agents", "plugins", `${layer}.json`);
}

function harnessCalls(runtime: FixtureRuntime, binary: string): string[] {
  return runtime.calls
    .filter((call) => call.command === binary)
    .map((call) => call.args.join(" "));
}

function pluginLockPath(repoDir: string): string {
  return join(repoDir, "scripts", "agents", "plugins.lock.json");
}

function lockPlugin(plugin: {
  marketplace: string;
  name: string;
  harnesses?: readonly string[];
  cursorMode?: "marketplace" | "skills";
}): unknown {
  return {
    marketplace: plugin.marketplace,
    marketplaceId: plugin.marketplace.split("/")[1],
    name: plugin.name,
    cursorMode: plugin.cursorMode ?? "marketplace",
    harnesses: plugin.harnesses ?? [...HARNESSES],
  };
}

function writePluginLock(repoDir: string, plugins: Parameters<typeof lockPlugin>[0][]): void {
  writeFileSync(
    pluginLockPath(repoDir),
    JSON.stringify({ version: 1, plugins: plugins.map(lockPlugin) }, null, 2),
  );
}

test("defaults a manifest entry to every harness and derives the marketplace id", () => {
  const { repoDir } = createFixture();
  const plugins = readPlugins(manifestPath(repoDir, "developer"));
  const first = plugins[0];

  assert.ok(first !== undefined);
  assert.deepEqual(first.harnesses, HARNESSES);
  assert.equal(first.marketplaceId, "shared-market");
  assert.equal(first.cursorMode, "marketplace");
  assert.equal(pluginRef(first), "shared-plugin@shared-market");
});

test("rejects an unknown cursorMode and skills mode without cursor and claude", () => {
  const { repoDir } = createFixture();
  writeManifest(repoDir, "developer", [
    { marketplace: "fixture/market", name: "one", cursorMode: "symlink" },
  ]);
  assert.throws(
    () => readPlugins(manifestPath(repoDir, "developer")),
    /cursorMode must be "marketplace" or "skills"/,
  );

  writeManifest(repoDir, "developer", [
    { marketplace: "fixture/market", name: "one", cursorMode: "skills", harnesses: ["cursor"] },
  ]);
  assert.throws(
    () => readPlugins(manifestPath(repoDir, "developer")),
    /sets cursorMode "skills" without targeting cursor and claude/,
  );

  writeManifest(repoDir, "developer", [
    { marketplace: "fixture/market", name: "one", cursorMode: "skills", harnesses: ["claude"] },
  ]);
  assert.throws(
    () => readPlugins(manifestPath(repoDir, "developer")),
    /sets cursorMode "skills" without targeting cursor and claude/,
  );
});

test("honours an explicit marketplaceId when the marketplace name diverges", () => {
  const { repoDir } = createFixture();
  writeManifest(repoDir, "developer", [
    { marketplace: "fixture/dotfiles-marketplace", name: "one", marketplaceId: "renamed" },
  ]);

  assert.equal(readPlugins(manifestPath(repoDir, "developer"))[0]?.marketplaceId, "renamed");
});

test("rejects a marketplace that is not owner/repo", () => {
  const { repoDir } = createFixture();
  writeManifest(repoDir, "developer", [{ marketplace: "fixture", name: "one" }]);

  assert.throws(
    () => readPlugins(manifestPath(repoDir, "developer")),
    /expected owner\/repo marketplace and safe plugin name strings/,
  );
});

test("rejects an unsafe plugin name before planning any command", () => {
  const { repoDir } = createFixture();
  writeManifest(repoDir, "developer", [{ marketplace: "fixture/market", name: "../escape" }]);

  assert.throws(
    () => readPlugins(manifestPath(repoDir, "developer")),
    /expected owner\/repo marketplace and safe plugin name strings/,
  );
});

test("rejects an unknown or duplicated harness", () => {
  const { repoDir } = createFixture();
  writeManifest(repoDir, "developer", [
    { marketplace: "fixture/market", name: "one", harnesses: ["claude", "windsurf"] },
  ]);
  assert.throws(() => readPlugins(manifestPath(repoDir, "developer")), /harnesses must be a unique/);

  writeManifest(repoDir, "developer", [
    { marketplace: "fixture/market", name: "one", harnesses: ["claude", "claude"] },
  ]);
  assert.throws(() => readPlugins(manifestPath(repoDir, "developer")), /harnesses must be a unique/);

  writeManifest(repoDir, "developer", [
    { marketplace: "fixture/market", name: "one", harnesses: [] },
  ]);
  assert.throws(() => readPlugins(manifestPath(repoDir, "developer")), /harnesses must be a unique/);
});

test("plans one marketplace add per marketplace followed by each install", () => {
  const { repoDir } = createFixture();
  const plugins = readPlugins(manifestPath(repoDir, "developer"));

  assert.deepEqual(
    planHarness("claude", plugins).map((planned) => `${planned.command} ${planned.args.join(" ")}`),
    [
      "claude plugin marketplace add fixture/shared-market",
      "claude plugin install shared-plugin@shared-market",
      "claude plugin install second-plugin@shared-market",
    ],
  );
  assert.deepEqual(
    planHarness("codex", plugins).map((planned) => `${planned.command} ${planned.args.join(" ")}`),
    [
      "codex plugin marketplace add fixture/shared-market",
      "codex plugin add shared-plugin@shared-market",
      "codex plugin add second-plugin@shared-market",
    ],
  );
});

test("rejects an entry that targets opencode without claude", () => {
  const { repoDir } = createFixture();
  writeManifest(repoDir, "developer", [
    { marketplace: "fixture/market", name: "one", harnesses: ["opencode"] },
  ]);

  assert.throws(
    () => readPlugins(manifestPath(repoDir, "developer")),
    /targets opencode without claude/,
  );
});

test("refuses to repoint a symlink sync does not manage", () => {
  const { repoDir, home } = createFixture();
  mkdirSync(join(home, ".config", "opencode", "skills"), { recursive: true });
  mkdirSync(join(home, "my-own-alpha"), { recursive: true });
  symlinkSync(join(home, "my-own-alpha"), opencodeLink(home, "alpha"));
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /link alpha \(conflicting entry\)/);
  assert.match(runtime.stderr.value, /which sync does not manage/);
  assert.equal(readlinkSync(opencodeLink(home, "alpha")), join(home, "my-own-alpha"));
});

test("plans one trusted source install for Grok and no commands for OpenCode", () => {
  const { repoDir } = createFixture();
  const plugins = readPlugins(manifestPath(repoDir, "developer"));

  assert.deepEqual(
    planHarness("grok", plugins).map((planned) => `${planned.command} ${planned.args.join(" ")}`),
    ["grok plugin install fixture/shared-market --trust"],
  );
  assert.deepEqual(planHarness("opencode", plugins), []);
});

test("plans only a marketplace add for Cursor and uses its URL form", () => {
  const { repoDir } = createFixture();
  const plugins = readPlugins(manifestPath(repoDir, "developer"));

  assert.deepEqual(
    planHarness("cursor", plugins).map((planned) => `${planned.command} ${planned.args.join(" ")}`),
    ["cursor-agent plugin marketplace add github.com/fixture/shared-market"],
  );
  assert.deepEqual(
    planHarness("cursor", plugins, { update: true }).map(
      (planned) => `${planned.command} ${planned.args.join(" ")}`,
    ),
    ["cursor-agent plugin marketplace add github.com/fixture/shared-market"],
  );
});

test("plans Claude plugin updates and Codex marketplace upgrades only with --update", () => {
  const { repoDir } = createFixture();
  const plugins = readPlugins(manifestPath(repoDir, "developer"));

  assert.deepEqual(
    planHarness("claude", plugins, { update: true }).map(
      (planned) => `${planned.command} ${planned.args.join(" ")}`,
    ),
    [
      "claude plugin marketplace add fixture/shared-market",
      "claude plugin install shared-plugin@shared-market",
      "claude plugin install second-plugin@shared-market",
      "claude plugin update shared-plugin@shared-market -y",
      "claude plugin update second-plugin@shared-market -y",
    ],
  );
  assert.deepEqual(
    planHarness("codex", plugins, { update: true }).map(
      (planned) => `${planned.command} ${planned.args.join(" ")}`,
    ),
    [
      "codex plugin marketplace add fixture/shared-market",
      "codex plugin marketplace upgrade shared-market",
      "codex plugin add shared-plugin@shared-market",
      "codex plugin add second-plugin@shared-market",
    ],
  );
  assert.deepEqual(
    planHarness("grok", plugins, { update: true }).map(
      (planned) => `${planned.command} ${planned.args.join(" ")}`,
    ),
    ["grok plugin install fixture/shared-market --trust"],
  );
});

test("plans nothing for a harness the entry does not target", () => {
  const { repoDir } = createFixture();
  const plugins = readPlugins(manifestPath(repoDir, "personal"));

  assert.equal(planHarness("claude", plugins).length, 2);
  assert.deepEqual(planHarness("codex", plugins), []);
  assert.deepEqual(planHarness("cursor", plugins), []);
});

test("applies the developer layer across every installed harness", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 0);
  assert.deepEqual(harnessCalls(runtime, "claude"), [
    "plugin marketplace add fixture/shared-market",
    "plugin install shared-plugin@shared-market",
    "plugin install second-plugin@shared-market",
  ]);
  assert.deepEqual(harnessCalls(runtime, "codex"), [
    "plugin marketplace add fixture/shared-market",
    "plugin add shared-plugin@shared-market",
    "plugin add second-plugin@shared-market",
  ]);
  assert.deepEqual(harnessCalls(runtime, "grok"), [
    "plugin list",
    "plugin install fixture/shared-market --trust",
  ]);
  assert.match(runtime.stdout.value, /Plugin layers: developer/);
  assert.match(runtime.stdout.value, /Done\./);
});

test("links the Claude checkout's skills into OpenCode's skill directory", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 0);
  assert.deepEqual(harnessCalls(runtime, "opencode"), []);
  for (const skill of ["alpha", "beta"]) {
    assert.equal(
      readlinkSync(opencodeLink(home, skill)),
      join(home, ".claude", "plugins", "marketplaces", "shared-market", "skills", skill),
    );
  }
  assert.match(runtime.stdout.value, /OpenCode: linked 2 shared-market skills/);
});

test("skips a Grok source its plugin list already contains", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, {
    outputs: new Map([
      [
        "grok plugin list",
        "  shared-abc123: shared-plugin [git: https://github.com/fixture/shared-market]\n",
      ],
    ]),
  });

  assert.equal(main([], runtime), 0);
  assert.deepEqual(harnessCalls(runtime, "grok"), ["plugin list"]);
  assert.match(runtime.stdout.value, /Grok: fixture\/shared-market is already installed/);
});

test("refreshes a stale installed plugin or source on --update", () => {
  const { repoDir, home } = createFixture();
  const grokList =
    "  shared-abc123: shared-plugin [git: https://github.com/fixture/shared-market]\n";
  const runtime = new FixtureRuntime(repoDir, home, {
    outputs: new Map([["grok plugin list", grokList]]),
  });

  assert.equal(main(["--update"], runtime), 0);
  assert.deepEqual(harnessCalls(runtime, "claude"), [
    "plugin marketplace add fixture/shared-market",
    "plugin install shared-plugin@shared-market",
    "plugin install second-plugin@shared-market",
    "plugin update shared-plugin@shared-market -y",
    "plugin update second-plugin@shared-market -y",
  ]);
  assert.deepEqual(harnessCalls(runtime, "codex"), [
    "plugin marketplace add fixture/shared-market",
    "plugin marketplace upgrade shared-market",
    "plugin add shared-plugin@shared-market",
    "plugin add second-plugin@shared-market",
  ]);
  assert.deepEqual(harnessCalls(runtime, "grok"), ["plugin list", "plugin update shared-plugin"]);
  assert.deepEqual(harnessCalls(runtime, "cursor-agent"), [
    "plugin marketplace add github.com/fixture/shared-market",
  ]);
  assert.deepEqual(harnessCalls(runtime, "opencode"), []);
  for (const skill of ["alpha", "beta"]) {
    assert.equal(
      readlinkSync(opencodeLink(home, skill)),
      join(home, ".claude", "plugins", "marketplaces", "shared-market", "skills", skill),
    );
  }
});

test("keeps Cursor and OpenCode skill links after a Claude source refresh", () => {
  const { repoDir, home } = createFixture();
  writeManifest(repoDir, "developer", [
    { marketplace: "fixture/shared-market", name: "shared-plugin", cursorMode: "skills" },
  ]);
  assert.equal(main([], new FixtureRuntime(repoDir, home)), 0);
  const alpha = join(home, ".claude", "plugins", "marketplaces", "shared-market", "skills", "alpha");
  assert.equal(readlinkSync(opencodeLink(home, "alpha")), alpha);
  assert.equal(readlinkSync(cursorLink(home, "alpha")), alpha);

  const runtime = new FixtureRuntime(repoDir, home);
  assert.equal(main(["--update"], runtime), 0);
  assert.ok(harnessCalls(runtime, "claude").includes("plugin update shared-plugin@shared-market -y"));
  assert.deepEqual(harnessCalls(runtime, "cursor-agent"), []);
  assert.equal(readlinkSync(opencodeLink(home, "alpha")), alpha);
  assert.equal(readlinkSync(cursorLink(home, "alpha")), alpha);
  assert.equal(existsSync(join(alpha, "SKILL.md")), true);
});

test("reports a Grok source that is installed but has no managed name to update", () => {
  const { repoDir, home } = createFixture();
  writePluginLock(repoDir, fixtureSharedPlugins);
  const previous = JSON.parse(readFileSync(pluginLockPath(repoDir), "utf8"));
  const runtime = new FixtureRuntime(repoDir, home, {
    outputs: new Map([
      [
        "grok plugin list",
        "  other-abc123: other-plugin [git: https://github.com/fixture/shared-market]\n",
      ],
    ]),
  });

  assert.equal(main(["--update"], runtime), 1);
  assert.deepEqual(harnessCalls(runtime, "grok"), ["plugin list"]);
  assert.match(runtime.stderr.value, /Grok: fixture\/shared-market could not be refreshed/);
  assert.deepEqual(JSON.parse(readFileSync(pluginLockPath(repoDir), "utf8")), previous);
});

test("skips refresh commands after their marketplace add or plugin install fails", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, {
    failures: new Map([
      ["codex plugin marketplace add fixture/shared-market", { stdout: "", stderr: "name taken" }],
      [
        "claude plugin install shared-plugin@shared-market",
        { stdout: "", stderr: "install failed" },
      ],
    ]),
  });

  assert.equal(main(["--update"], runtime), 1);
  assert.deepEqual(harnessCalls(runtime, "codex"), [
    "plugin marketplace add fixture/shared-market",
    "plugin add shared-plugin@shared-market",
    "plugin add second-plugin@shared-market",
  ]);
  assert.deepEqual(harnessCalls(runtime, "claude"), [
    "plugin marketplace add fixture/shared-market",
    "plugin install shared-plugin@shared-market",
    "plugin install second-plugin@shared-market",
    "plugin update second-plugin@shared-market -y",
  ]);

  const addFailed = new FixtureRuntime(repoDir, home, {
    failures: new Map([
      ["claude plugin marketplace add fixture/shared-market", { stdout: "", stderr: "name taken" }],
    ]),
  });
  assert.equal(main(["--update"], addFailed), 1);
  assert.deepEqual(harnessCalls(addFailed, "claude"), [
    "plugin marketplace add fixture/shared-market",
    "plugin install shared-plugin@shared-market",
    "plugin install second-plugin@shared-market",
  ]);
});

test("does not prune or advance ownership when a plugin refresh fails", () => {
  const { repoDir, home } = createFixture();
  const retired = { marketplace: "fixture/retired-market", name: "retired-plugin" };
  const previous = { version: 1, plugins: [...fixtureSharedPlugins, retired].map(lockPlugin) };
  const grokList =
    "  shared-abc123: shared-plugin [git: https://github.com/fixture/shared-market]\n";

  for (const [command, stderr] of [
    ["claude plugin update shared-plugin@shared-market -y", "stale cache locked"],
    ["codex plugin marketplace upgrade shared-market", "upgrade failed"],
    ["grok plugin update shared-plugin", "update failed"],
  ] as const) {
    writePluginLock(repoDir, [...fixtureSharedPlugins, retired]);
    const runtime = new FixtureRuntime(repoDir, home, {
      outputs: new Map([["grok plugin list", grokList]]),
      failures: new Map([[command, { stdout: "", stderr }]]),
    });

    assert.equal(main(["--update"], runtime), 1);
    assert.equal(
      harnessCalls(runtime, "claude").some((call) => call.includes("uninstall")),
      false,
    );
    assert.deepEqual(JSON.parse(readFileSync(pluginLockPath(repoDir), "utf8")), previous);
  }
});

test("fails OpenCode linking when the Claude checkout is missing", () => {
  const { repoDir, home } = createFixture();
  rmSync(join(home, ".claude", "plugins", "marketplaces", "shared-market"), {
    force: true,
    recursive: true,
  });
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /link shared-plugin@shared-market skills \(missing Claude checkout\)/);
  assert.match(runtime.stderr.value, /the Claude Code plugin sync creates it/);
});

test("refuses to replace a non-symlink entry in OpenCode's skill directory", () => {
  const { repoDir, home } = createFixture();
  mkdirSync(opencodeLink(home, "alpha"), { recursive: true });
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /link alpha \(conflicting entry\)/);
  assert.ok(lstatSync(opencodeLink(home, "alpha")).isDirectory());
  assert.equal(readlinkSync(opencodeLink(home, "beta")).endsWith("beta"), true);
});

test("repoints a stale owned link and leaves never-owned marketplace links", () => {
  const { repoDir, home } = createFixture();
  const managedRoot = join(home, ".claude", "plugins", "marketplaces");
  mkdirSync(join(home, ".config", "opencode", "skills"), { recursive: true });
  symlinkSync(join(managedRoot, "gone-market", "skills", "gone"), opencodeLink(home, "gone"));
  symlinkSync(join(home, "elsewhere"), opencodeLink(home, "foreign"));

  assert.equal(main([], new FixtureRuntime(repoDir, home)), 0);
  assert.equal(lstatSync2Exists(opencodeLink(home, "gone")), true);
  unlinkSync(opencodeLink(home, "alpha"));
  symlinkSync(join(managedRoot, "shared-market", "skills", "beta"), opencodeLink(home, "alpha"));
  symlinkSync(join(managedRoot, "shared-market", "skills", "ghost"), opencodeLink(home, "ghost"));

  const runtime = new FixtureRuntime(repoDir, home);
  assert.equal(main([], runtime), 0);
  assert.equal(
    readlinkSync(opencodeLink(home, "alpha")),
    join(managedRoot, "shared-market", "skills", "alpha"),
  );
  assert.equal(lstatSync2Exists(opencodeLink(home, "ghost")), false);
  assert.equal(lstatSync2Exists(opencodeLink(home, "gone")), true);
  assert.equal(lstatSync2Exists(opencodeLink(home, "foreign")), true);
  assert.match(runtime.stdout.value, /removed 1 stale managed skill links/);
});

function lstatSync2Exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

test("adds the personal layer only for personal profiles", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, { profile: "personal-devbox" });

  assert.equal(main(["--profile", "personal-devbox"], runtime), 0);
  assert.match(runtime.stdout.value, /Plugin layers: developer, devbox, personal/);
  assert.ok(harnessCalls(runtime, "claude").includes("plugin install personal-plugin@personal-market"));
  assert.ok(harnessCalls(runtime, "claude").includes("plugin marketplace add fixture/personal-market"));
  assert.equal(
    harnessCalls(runtime, "codex").some((call) => call.includes("personal-plugin")),
    false,
  );
});

test("emits a one-line interactive notice for Cursor instead of installing", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 0);
  assert.deepEqual(harnessCalls(runtime, "cursor-agent"), [
    "plugin marketplace add github.com/fixture/shared-market",
  ]);
  assert.match(
    runtime.stdout.value,
    /Cursor plugin installation is interactive; run \/plugins to enable shared-plugin@shared-market, second-plugin@shared-market/,
  );
});

test("links a native-skills plugin into Cursor and plans no marketplace for it", () => {
  const { repoDir, home } = createFixture();
  writeManifest(repoDir, "developer", [
    ...fixtureSharedPlugins,
    { marketplace: "fixture/native-market", name: "native-plugin", cursorMode: "skills" },
  ]);
  writeClaudeCheckout(home, "native-market", ["delta"]);
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 0);
  assert.deepEqual(harnessCalls(runtime, "cursor-agent"), [
    "plugin marketplace add github.com/fixture/shared-market",
  ]);
  assert.equal(
    readlinkSync(cursorLink(home, "delta")),
    join(home, ".claude", "plugins", "marketplaces", "native-market", "skills", "delta"),
  );
  assert.match(runtime.stdout.value, /Cursor: linked 1 native-market skills/);
  assert.match(
    runtime.stdout.value,
    /run \/plugins to enable shared-plugin@shared-market, second-plugin@shared-market/,
  );
  assert.doesNotMatch(runtime.stdout.value, /enable.*native-plugin/);
});

test("skips every Cursor marketplace command when all plugins are native skills", () => {
  const { repoDir, home } = createFixture();
  writeManifest(repoDir, "developer", [
    { marketplace: "fixture/shared-market", name: "shared-plugin", cursorMode: "skills" },
  ]);
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 0);
  assert.deepEqual(harnessCalls(runtime, "cursor-agent"), []);
  assert.deepEqual(planHarness("cursor", readPlugins(manifestPath(repoDir, "developer"))), []);
  for (const skill of ["alpha", "beta"]) {
    assert.equal(readlinkSync(cursorLink(home, skill)).endsWith(skill), true);
  }
  assert.doesNotMatch(runtime.stdout.value, /Cursor plugin installation is interactive/);
  assert.equal(main([], new FixtureRuntime(repoDir, home)), 0);
  assert.equal(readlinkSync(cursorLink(home, "alpha")).endsWith("alpha"), true);
});

test("prunes Cursor links when a plugin returns to marketplace mode", () => {
  const { repoDir, home } = createFixture();
  writeManifest(repoDir, "developer", [
    { marketplace: "fixture/shared-market", name: "shared-plugin", cursorMode: "skills" },
  ]);
  assert.equal(main([], new FixtureRuntime(repoDir, home)), 0);
  assert.equal(lstatSync2Exists(cursorLink(home, "alpha")), true);

  writeManifest(repoDir, "developer", [
    { marketplace: "fixture/shared-market", name: "shared-plugin" },
  ]);
  const runtime = new FixtureRuntime(repoDir, home);
  assert.equal(main([], runtime), 0);
  assert.equal(lstatSync2Exists(cursorLink(home, "alpha")), false);
  assert.equal(lstatSync2Exists(cursorLink(home, "beta")), false);
  assert.match(runtime.stdout.value, /Cursor: removed 2 stale managed skill links/);
});

test("refuses to replace a non-symlink entry in Cursor's skill directory", () => {
  const { repoDir, home } = createFixture();
  writeManifest(repoDir, "developer", [
    { marketplace: "fixture/shared-market", name: "shared-plugin", cursorMode: "skills" },
  ]);
  mkdirSync(cursorLink(home, "alpha"), { recursive: true });
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /Cursor: link alpha \(conflicting entry\)/);
  assert.ok(lstatSync(cursorLink(home, "alpha")).isDirectory());
});

test("skips a harness whose CLI is not installed", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home);
  runtime.installedCommands.delete("codex");
  runtime.installedCommands.delete("cursor-agent");

  assert.equal(main([], runtime), 0);
  assert.match(runtime.stdout.value, /Skipping Codex plugins: 'codex' is not installed/);
  assert.match(runtime.stdout.value, /Skipping Cursor plugins: 'cursor-agent' is not installed/);
  assert.deepEqual(harnessCalls(runtime, "codex"), []);
  assert.deepEqual(harnessCalls(runtime, "cursor-agent"), []);
  assert.equal(harnessCalls(runtime, "claude").length, 3);
});

test("repeating a successful apply issues the same commands and exits 0", () => {
  const { repoDir, home } = createFixture();
  const first = new FixtureRuntime(repoDir, home);
  const second = new FixtureRuntime(repoDir, home);

  assert.equal(main([], first), 0);
  assert.equal(main([], second), 0);
  assert.deepEqual(first.calls, second.calls);
});

test("reports every failing command with a redacted diagnostic", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, {
    failures: new Map([
      [
        "claude plugin marketplace add fixture/shared-market",
        { stdout: "", stderr: "fatal: repository not found\ntoken=stderr-secret" },
      ],
    ]),
  });

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /Plugin sync failed for 1 failure:/);
  assert.match(runtime.stderr.value, /Claude Code: plugin marketplace add fixture\/shared-market \(exit 1\)/);
  assert.match(runtime.stderr.value, /token=\[REDACTED\]/);
  assert.doesNotMatch(runtime.stderr.value, /stderr-secret/);
  assert.doesNotMatch(runtime.stdout.value, /Done\./);
});

test("rejects a conflicting plugin definition across selected layers", () => {
  const { repoDir, home } = createFixture();
  writeManifest(repoDir, "personal", [
    { marketplace: "fixture/shared-market", name: "shared-plugin", harnesses: ["claude"] },
  ]);
  const runtime = new FixtureRuntime(repoDir, home, { profile: "personal-workstation" });

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /shared-plugin@shared-market is defined more than once/);
  assert.equal(harnessCalls(runtime, "claude").length, 0);
});

test("collapses an identical plugin selected by more than one layer", () => {
  const { repoDir, home } = createFixture();
  writeManifest(repoDir, "personal", fixtureSharedPlugins);
  const runtime = new FixtureRuntime(repoDir, home, { profile: "personal-workstation" });

  assert.equal(main([], runtime), 0);
  const installs = harnessCalls(runtime, "claude").filter((call) =>
    call.startsWith("plugin install"),
  );
  assert.deepEqual(installs, [
    "plugin install shared-plugin@shared-market",
    "plugin install second-plugin@shared-market",
  ]);
});

test("refuses profiles without agent setup before touching a harness", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, { profile: "assistant" });

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /Plugin sync failed: Profile resolution failed/);
  assert.equal(runtime.calls.length, 1);
});

test("rejects unknown arguments and prints help without applying", () => {
  const { repoDir, home } = createFixture();
  const rejected = new FixtureRuntime(repoDir, home);
  assert.equal(main(["--unexpected"], rejected), 2);
  assert.match(rejected.stderr.value, /Unknown argument: --unexpected/);
  assert.equal(rejected.calls.length, 0);

  const helped = new FixtureRuntime(repoDir, home);
  assert.equal(main(["--help"], helped), 0);
  assert.match(
    helped.stdout.value,
    /Usage: \.\/scripts\/agents\/plugins\.ts \[--profile PROFILE\] \[--update\]/,
  );
  assert.equal(helped.calls.length, 0);
});

test("every real plugin manifest parses", () => {
  for (const layer of ["developer", "workstation", "devbox", "personal"]) {
    readPlugins(join(repoRoot, `scripts/agents/plugins/${layer}.json`));
  }
});

test("initializes a missing ownership lock without removing unowned plugins", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 0);
  assert.equal(
    harnessCalls(runtime, "claude").some((call) => call.includes("uninstall")),
    false,
  );
  assert.deepEqual(
    JSON.parse(readFileSync(pluginLockPath(repoDir), "utf8")),
    {
      version: 1,
      plugins: readLayeredPlugins(repoDir, "workstation", ["developer", "workstation"]).plugins,
    },
  );
  assert.match(runtime.stdout.value, /Initializing managed plugins lock without removing existing plugins/);
});

test("removes only plugins dropped from the previous managed lock", () => {
  const { repoDir, home } = createFixture();
  const retired = { marketplace: "fixture/retired-market", name: "retired-plugin" };
  writePluginLock(repoDir, [...fixtureSharedPlugins, retired]);
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 0);
  assert.ok(harnessCalls(runtime, "claude").includes("plugin uninstall -y retired-plugin@retired-market"));
  assert.ok(harnessCalls(runtime, "codex").includes("plugin remove retired-plugin@retired-market"));
  assert.ok(harnessCalls(runtime, "grok").includes("plugin uninstall retired-plugin --confirm"));
  assert.match(
    runtime.stdout.value,
    /Cursor plugin removal is interactive; disable retired-plugin@retired-market in \/plugins/,
  );
  const locked = JSON.parse(readFileSync(pluginLockPath(repoDir), "utf8")).plugins;
  assert.deepEqual(
    locked.map(pluginRef),
    ["shared-plugin@shared-market", "second-plugin@shared-market", "retired-plugin@retired-market"],
  );
  assert.deepEqual(locked[2]?.harnesses, ["cursor"]);
});

test("keeps a dropped plugin in the lock when its harness CLI is missing", () => {
  const { repoDir, home } = createFixture();
  const retired = { marketplace: "fixture/retired-market", name: "retired-plugin", harnesses: ["codex"] };
  writePluginLock(repoDir, [...fixtureSharedPlugins, retired]);
  const runtime = new FixtureRuntime(repoDir, home);
  runtime.installedCommands.delete("codex");

  assert.equal(main([], runtime), 0);
  assert.equal(
    harnessCalls(runtime, "codex").some((call) => call.includes("retired-plugin")),
    false,
  );
  assert.match(runtime.stdout.value, /Skipping Codex plugin removal: 'codex' is not installed/);
  const locked = JSON.parse(readFileSync(pluginLockPath(repoDir), "utf8")).plugins;
  assert.deepEqual(
    locked.map(pluginRef),
    ["shared-plugin@shared-market", "second-plugin@shared-market", "retired-plugin@retired-market"],
  );
  assert.deepEqual(locked[2]?.harnesses, ["codex"]);
});

test("does not prune or advance ownership when installation fails", () => {
  const { repoDir, home } = createFixture();
  const retired = { marketplace: "fixture/retired-market", name: "retired-plugin" };
  const previous = { version: 1, plugins: [...fixtureSharedPlugins, retired].map(lockPlugin) };
  writePluginLock(repoDir, [...fixtureSharedPlugins, retired]);
  const runtime = new FixtureRuntime(repoDir, home, {
    failures: new Map([
      ["claude plugin marketplace add fixture/shared-market", { stdout: "", stderr: "install failed" }],
    ]),
  });

  assert.equal(main([], runtime), 1);
  assert.equal(
    harnessCalls(runtime, "claude").some((call) => call.includes("uninstall")),
    false,
  );
  assert.deepEqual(JSON.parse(readFileSync(pluginLockPath(repoDir), "utf8")), previous);
});

test("does not advance ownership when a managed removal fails", () => {
  const { repoDir, home } = createFixture();
  const retired = { marketplace: "fixture/retired-market", name: "retired-plugin" };
  const previous = { version: 1, plugins: [...fixtureSharedPlugins, retired].map(lockPlugin) };
  writePluginLock(repoDir, [...fixtureSharedPlugins, retired]);
  const runtime = new FixtureRuntime(repoDir, home, {
    failures: new Map([
      ["claude plugin uninstall -y retired-plugin@retired-market", { stdout: "", stderr: "remove failed" }],
    ]),
  });

  assert.equal(main([], runtime), 1);
  assert.ok(harnessCalls(runtime, "claude").includes("plugin uninstall -y retired-plugin@retired-market"));
  assert.deepEqual(JSON.parse(readFileSync(pluginLockPath(repoDir), "utf8")), previous);
  assert.match(runtime.stderr.value, /Plugin sync failed for 1 failure:/);
});

test("prunes OpenCode links when every plugin leaves the selection", () => {
  const { repoDir, home } = createFixture();
  assert.equal(main([], new FixtureRuntime(repoDir, home)), 0);
  assert.equal(lstatSync2Exists(opencodeLink(home, "alpha")), true);

  writeManifest(repoDir, "developer", []);
  const runtime = new FixtureRuntime(repoDir, home);
  assert.equal(main([], runtime), 0);
  assert.equal(lstatSync2Exists(opencodeLink(home, "alpha")), false);
  assert.equal(lstatSync2Exists(opencodeLink(home, "beta")), false);
  assert.match(runtime.stdout.value, /OpenCode: removed 2 stale managed skill links/);
});

test("rejects an unsafe ownership lock before changing plugins", () => {
  const { repoDir, home } = createFixture();
  writePluginLock(repoDir, [{ marketplace: "fixture/market", name: "../escape" }]);
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /Invalid managed plugins lock/);
  assert.equal(harnessCalls(runtime, "claude").length, 0);
});

test("rejects a lock that omits explicit harness membership", () => {
  const { repoDir, home } = createFixture();
  writeFileSync(
    pluginLockPath(repoDir),
    JSON.stringify({
      version: 1,
      plugins: [
        {
          marketplace: "fixture/shared-market",
          marketplaceId: "shared-market",
          name: "shared-plugin",
          cursorMode: "marketplace",
        },
      ],
    }),
  );
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /expected explicit marketplace, marketplaceId, name, cursorMode, and harnesses/);
  assert.equal(harnessCalls(runtime, "claude").length, 0);
});

test("accepts a residual OpenCode-only lock after Claude removal succeeded", () => {
  const { repoDir, home } = createFixture();
  writePluginLock(repoDir, [
    ...fixtureSharedPlugins,
    { marketplace: "fixture/retired-market", name: "retired-plugin", harnesses: ["opencode"] },
  ]);
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 0);
  const locked = JSON.parse(readFileSync(pluginLockPath(repoDir), "utf8")).plugins;
  assert.equal(
    locked.some((plugin: { name: string }) => plugin.name === "retired-plugin"),
    false,
  );
});

test("records only harnesses whose CLI was present", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home);
  runtime.installedCommands.delete("grok");

  assert.equal(main([], runtime), 0);
  const locked = JSON.parse(readFileSync(pluginLockPath(repoDir), "utf8")).plugins;
  for (const plugin of locked) {
    assert.equal(plugin.harnesses.includes("grok"), false);
    assert.ok(plugin.harnesses.includes("claude"));
  }
});

test("keeps previously owned harnesses when that CLI is temporarily absent", () => {
  const { repoDir, home } = createFixture();
  writePluginLock(repoDir, fixtureSharedPlugins);
  const runtime = new FixtureRuntime(repoDir, home);
  runtime.installedCommands.delete("grok");

  assert.equal(main([], runtime), 0);
  const locked = JSON.parse(readFileSync(pluginLockPath(repoDir), "utf8")).plugins;
  assert.ok(locked[0]?.harnesses.includes("grok"));
});

test("does not prune owned links when a later apply fails", () => {
  const { repoDir, home } = createFixture();
  assert.equal(main([], new FixtureRuntime(repoDir, home)), 0);
  rmSync(join(home, ".claude", "plugins", "marketplaces", "shared-market"), {
    force: true,
    recursive: true,
  });
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 1);
  assert.equal(lstatSync2Exists(opencodeLink(home, "alpha")), true);
  assert.equal(lstatSync2Exists(opencodeLink(home, "beta")), true);
});

test("does not replace an owned skill name when a new marketplace reuses it", () => {
  const { repoDir, home } = createFixture();
  const managedRoot = join(home, ".claude", "plugins", "marketplaces");
  assert.equal(main([], new FixtureRuntime(repoDir, home)), 0);
  writeClaudeCheckout(home, "fresh-market", ["alpha"]);
  writeManifest(repoDir, "developer", [
    ...fixtureSharedPlugins,
    { marketplace: "fixture/fresh-market", name: "fresh-plugin" },
  ]);
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /link alpha \(conflicting entry\)/);
  assert.equal(
    readlinkSync(opencodeLink(home, "alpha")),
    join(managedRoot, "shared-market", "skills", "alpha"),
  );
});

test("keeps previous Cursor mode when that CLI is absent during a mode change", () => {
  const { repoDir, home } = createFixture();
  writePluginLock(repoDir, [
    { marketplace: "fixture/shared-market", name: "shared-plugin", cursorMode: "skills" },
    { marketplace: "fixture/shared-market", name: "second-plugin", cursorMode: "skills" },
  ]);
  writeManifest(repoDir, "developer", [
    { marketplace: "fixture/shared-market", name: "shared-plugin", cursorMode: "marketplace" },
    { marketplace: "fixture/shared-market", name: "second-plugin", cursorMode: "marketplace" },
  ]);
  const runtime = new FixtureRuntime(repoDir, home);
  runtime.installedCommands.delete("cursor-agent");

  assert.equal(main([], runtime), 0);
  const locked = JSON.parse(readFileSync(pluginLockPath(repoDir), "utf8")).plugins;
  assert.equal(locked[0]?.cursorMode, "skills");
  assert.ok(locked[0]?.harnesses.includes("cursor"));
});

test("keeps Cursor marketplace ownership when a plugin switches to skills mode", () => {
  const { repoDir, home } = createFixture();
  writePluginLock(repoDir, fixtureSharedPlugins);
  writeManifest(repoDir, "developer", [
    { marketplace: "fixture/shared-market", name: "shared-plugin", cursorMode: "skills" },
    { marketplace: "fixture/shared-market", name: "second-plugin", cursorMode: "skills" },
  ]);
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 0);
  assert.match(runtime.stdout.value, /disable shared-plugin@shared-market in \/plugins/);
  const locked = JSON.parse(readFileSync(pluginLockPath(repoDir), "utf8")).plugins;
  assert.equal(locked[0]?.cursorMode, "marketplace");
  assert.ok(locked[0]?.harnesses.includes("cursor"));
});

test("does not replace a never-owned link when a new marketplace is selected", () => {
  const { repoDir, home } = createFixture();
  const managedRoot = join(home, ".claude", "plugins", "marketplaces");
  assert.equal(main([], new FixtureRuntime(repoDir, home)), 0);

  writeClaudeCheckout(home, "fresh-market", ["delta"]);
  writeManifest(repoDir, "developer", [
    ...fixtureSharedPlugins,
    { marketplace: "fixture/fresh-market", name: "fresh-plugin" },
  ]);
  symlinkSync(join(managedRoot, "fresh-market", "skills", "other"), opencodeLink(home, "delta"));
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /link delta \(conflicting entry\)/);
  assert.equal(
    readlinkSync(opencodeLink(home, "delta")),
    join(managedRoot, "fresh-market", "skills", "other"),
  );
});

test("does not replace a managed-looking link on first apply", () => {
  const { repoDir, home } = createFixture();
  const managedRoot = join(home, ".claude", "plugins", "marketplaces");
  mkdirSync(join(home, ".config", "opencode", "skills"), { recursive: true });
  symlinkSync(join(managedRoot, "other-market", "skills", "alpha"), opencodeLink(home, "alpha"));
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /link alpha \(conflicting entry\)/);
  assert.equal(
    readlinkSync(opencodeLink(home, "alpha")),
    join(managedRoot, "other-market", "skills", "alpha"),
  );
});

test("the executable TypeScript entrypoint runs the CLI", () => {
  const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "plugins.ts");
  const result = spawnSync(scriptPath, ["unexpected"], { encoding: "utf8" });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: \.\/scripts\/agents\/plugins\.ts \[--profile PROFILE\] \[--update\]/);
  assert.match(result.stderr, /Unknown argument: unexpected/);
});
