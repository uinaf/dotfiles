import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { readProfileModel } from "../profiles/model.ts";
import { main, readLayeredServers, readServers } from "./mcps.ts";
import { HARNESSES } from "./plugins.ts";
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

type FixtureResult = {
  status: number;
  stdout: string;
  stderr: string;
};

type FixtureOptions = {
  failures?: ReadonlyMap<string, FixtureFailure>;
  outputs?: ReadonlyMap<string, string>;
  // Consumed one result per call for commands whose outcome changes between calls.
  sequences?: ReadonlyMap<string, FixtureResult[]>;
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
  readonly sequences: Map<string, FixtureResult[]>;
  readonly profile: string;
  readonly repoDir: string;

  constructor(repoDir: string, home: string, options: FixtureOptions = {}) {
    this.repoDir = repoDir;
    this.failures = options.failures ?? new Map();
    this.outputs = options.outputs ?? new Map();
    this.sequences = new Map(options.sequences ?? []);
    this.profile = options.profile ?? "workstation";
    this.env = { HOME: home };
  }

  commandExists(command: string): boolean {
    return this.installedCommands.has(command);
  }

  run(command: string, args: readonly string[]): { status: number; stdout: string; stderr: string } {
    this.calls.push({ command, args });

    if (command.endsWith("/resolve-profile.sh")) {
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

    const key = `${command} ${args.join(" ")}`;
    const sequence = this.sequences.get(key);
    if (sequence !== undefined && sequence.length > 0) {
      return sequence.shift() as FixtureResult;
    }

    const diagnostic = this.failures.get(key);
    if (diagnostic !== undefined) {
      return { status: 1, stdout: diagnostic.stdout, stderr: diagnostic.stderr };
    }
    return { status: 0, stdout: this.outputs.get(key) ?? "", stderr: "" };
  }
}

const temporaryDirectories: string[] = [];

const fixtureSharedServers = [{ name: "shared-mcp", url: "https://mcp.fixture.test/mcp" }];

const fixturePersonalServers = [
  { name: "personal-mcp", url: "https://personal.fixture.test/mcp", harnesses: ["claude"] },
];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function createFixture(): { repoDir: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-agents-mcps-"));
  temporaryDirectories.push(root);
  const repoDir = join(root, "repo");
  const home = join(root, "home");

  mkdirSync(join(repoDir, "scripts", "agents", "mcps"), { recursive: true });
  mkdirSync(join(repoDir, "chezmoi", ".chezmoidata"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(repoDir, "chezmoi", ".chezmoidata", "profiles.json"),
    readFileSync(join(repoRoot, "chezmoi", ".chezmoidata", "profiles.json")),
  );
  writeManifest(repoDir, "developer", fixtureSharedServers);
  writeManifest(repoDir, "workstation", []);
  writeManifest(repoDir, "devbox", []);
  writeManifest(repoDir, "personal", fixturePersonalServers);

  return { repoDir, home };
}

function writeManifest(repoDir: string, layer: string, servers: unknown): void {
  writeFileSync(
    join(repoDir, "scripts", "agents", "mcps", `${layer}.json`),
    JSON.stringify({ servers }, null, 2),
  );
}

function manifestPath(repoDir: string, layer: string): string {
  return join(repoDir, "scripts", "agents", "mcps", `${layer}.json`);
}

function harnessCalls(runtime: FixtureRuntime, binary: string): string[] {
  return runtime.calls
    .filter((call) => call.command === binary)
    .map((call) => call.args.join(" "));
}

function cursorConfigPath(home: string): string {
  return join(home, ".cursor", "mcp.json");
}

test("defaults a manifest entry to every harness", () => {
  const { repoDir } = createFixture();
  const servers = readServers(manifestPath(repoDir, "developer"));

  assert.equal(servers.length, 1);
  assert.deepEqual(servers[0]?.harnesses, HARNESSES);
});

test("rejects a non-https or malformed url", () => {
  const { repoDir } = createFixture();
  writeManifest(repoDir, "developer", [{ name: "one", url: "http://mcp.fixture.test/mcp" }]);
  assert.throws(() => readServers(manifestPath(repoDir, "developer")), /url must use https/);

  writeManifest(repoDir, "developer", [{ name: "one", url: "not-a-url" }]);
  assert.throws(() => readServers(manifestPath(repoDir, "developer")), /url is not a URL/);
});

test("rejects an unsafe server name and a duplicate name", () => {
  const { repoDir } = createFixture();
  writeManifest(repoDir, "developer", [{ name: "../escape", url: "https://mcp.fixture.test" }]);
  assert.throws(
    () => readServers(manifestPath(repoDir, "developer")),
    /expected safe server name and url strings/,
  );

  writeManifest(repoDir, "developer", [
    { name: "one", url: "https://mcp.fixture.test/a" },
    { name: "one", url: "https://mcp.fixture.test/b" },
  ]);
  assert.throws(() => readServers(manifestPath(repoDir, "developer")), /defined more than once/);
});

test("rejects an unknown or duplicated harness", () => {
  const { repoDir } = createFixture();
  writeManifest(repoDir, "developer", [
    { name: "one", url: "https://mcp.fixture.test", harnesses: ["claude", "windsurf"] },
  ]);
  assert.throws(() => readServers(manifestPath(repoDir, "developer")), /harnesses must be a unique/);
});

test("rejects a conflicting layered definition and collapses an identical one", () => {
  const { repoDir } = createFixture();
  writeManifest(repoDir, "personal", [
    { name: "shared-mcp", url: "https://other.fixture.test/mcp" },
  ]);
  assert.throws(
    () =>
      readLayeredServers(repoDir, "personal-workstation", ["developer", "workstation", "personal"]),
    /shared-mcp is defined more than once/,
  );

  writeManifest(repoDir, "personal", fixtureSharedServers);
  const { servers } = readLayeredServers(repoDir, "personal-workstation", [
    "developer",
    "workstation",
    "personal",
  ]);
  assert.deepEqual(
    servers.map((server) => server.name),
    ["shared-mcp"],
  );
});

test("adds each server through the upsert CLIs", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 0);
  assert.deepEqual(harnessCalls(runtime, "codex"), [
    "mcp get shared-mcp",
    "mcp add shared-mcp --url https://mcp.fixture.test/mcp",
  ]);
  assert.deepEqual(harnessCalls(runtime, "grok"), [
    "mcp add -t http -s user shared-mcp https://mcp.fixture.test/mcp",
  ]);
  assert.deepEqual(harnessCalls(runtime, "opencode"), [
    "mcp add shared-mcp --url https://mcp.fixture.test/mcp",
  ]);
  assert.match(runtime.stdout.value, /MCP layers: developer, workstation/);
  assert.match(runtime.stdout.value, /Done\./);
});

test("adds a Claude server its config does not know", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, {
    failures: new Map([["claude mcp get shared-mcp", { stdout: "", stderr: "not found" }]]),
  });

  assert.equal(main([], runtime), 0);
  assert.deepEqual(harnessCalls(runtime, "claude"), [
    "mcp get shared-mcp",
    "mcp add -t http -s user shared-mcp https://mcp.fixture.test/mcp",
  ]);
});

test("skips a Claude server whose URL already matches", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, {
    outputs: new Map([
      ["claude mcp get shared-mcp", "shared-mcp:\n  Type: http\n  URL: https://mcp.fixture.test/mcp\n"],
    ]),
  });

  assert.equal(main([], runtime), 0);
  assert.deepEqual(harnessCalls(runtime, "claude"), ["mcp get shared-mcp"]);
  assert.match(runtime.stdout.value, /Claude Code: shared-mcp is already configured/);
});

test("replaces a Claude server whose URL changed", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, {
    outputs: new Map([
      ["claude mcp get shared-mcp", "shared-mcp:\n  Type: http\n  URL: https://old.fixture.test/mcp\n"],
    ]),
  });

  assert.equal(main([], runtime), 0);
  assert.deepEqual(harnessCalls(runtime, "claude"), [
    "mcp get shared-mcp",
    "mcp remove -s user shared-mcp",
    "mcp add -t http -s user shared-mcp https://mcp.fixture.test/mcp",
  ]);
});

test("skips a Codex server whose URL already matches", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, {
    outputs: new Map([
      ["codex mcp get shared-mcp", "shared-mcp\n  url: https://mcp.fixture.test/mcp\n"],
    ]),
  });

  assert.equal(main([], runtime), 0);
  assert.deepEqual(harnessCalls(runtime, "codex"), ["mcp get shared-mcp"]);
  assert.match(runtime.stdout.value, /Codex: shared-mcp is already configured/);
});

test("downgrades a Codex add whose config landed before its login step failed", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, {
    failures: new Map([
      [
        "codex mcp add shared-mcp --url https://mcp.fixture.test/mcp",
        { stdout: "", stderr: "Error: timed out waiting for OAuth callback" },
      ],
    ]),
    sequences: new Map([
      [
        "codex mcp get shared-mcp",
        [
          { status: 1, stdout: "", stderr: "not found" },
          { status: 0, stdout: "shared-mcp\n  url: https://mcp.fixture.test/mcp\n", stderr: "" },
        ],
      ],
    ]),
  });

  assert.equal(main([], runtime), 0);
  assert.match(
    runtime.stdout.value,
    /Codex: shared-mcp is configured, but its login did not finish; run 'codex mcp login shared-mcp'/,
  );
});

test("writes the Cursor config and preserves foreign entries", () => {
  const { repoDir, home } = createFixture();
  mkdirSync(join(home, ".cursor"), { recursive: true });
  writeFileSync(
    cursorConfigPath(home),
    JSON.stringify(
      {
        mcpServers: { local: { command: "node", args: ["server.js"] } },
        otherSetting: true,
      },
      null,
      2,
    ),
  );
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 0);
  const written = JSON.parse(readFileSync(cursorConfigPath(home), "utf8"));
  assert.deepEqual(written.mcpServers["shared-mcp"], { url: "https://mcp.fixture.test/mcp" });
  assert.deepEqual(written.mcpServers.local, { command: "node", args: ["server.js"] });
  assert.equal(written.otherSetting, true);
  assert.match(runtime.stdout.value, /Cursor: updated /);
});

test("creates the Cursor config when it is absent and leaves a matching one alone", () => {
  const { repoDir, home } = createFixture();
  const first = new FixtureRuntime(repoDir, home);
  assert.equal(main([], first), 0);
  const written = readFileSync(cursorConfigPath(home), "utf8");
  assert.deepEqual(JSON.parse(written).mcpServers["shared-mcp"], {
    url: "https://mcp.fixture.test/mcp",
  });

  const second = new FixtureRuntime(repoDir, home);
  assert.equal(main([], second), 0);
  assert.match(second.stdout.value, /Cursor: 1 MCP server\(s\) already configured/);
  assert.equal(readFileSync(cursorConfigPath(home), "utf8"), written);
});

test("fails instead of overwriting an unreadable Cursor config", () => {
  const { repoDir, home } = createFixture();
  mkdirSync(join(home, ".cursor"), { recursive: true });
  writeFileSync(cursorConfigPath(home), "{not json");
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /is not valid JSON/);
  assert.equal(readFileSync(cursorConfigPath(home), "utf8"), "{not json");
});

test("narrows a server to its selected harnesses", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, {
    profile: "personal-workstation",
    failures: new Map([
      ["claude mcp get shared-mcp", { stdout: "", stderr: "not found" }],
      ["claude mcp get personal-mcp", { stdout: "", stderr: "not found" }],
    ]),
  });

  assert.equal(main(["--profile", "personal-workstation"], runtime), 0);
  assert.ok(
    harnessCalls(runtime, "claude").includes(
      "mcp add -t http -s user personal-mcp https://personal.fixture.test/mcp",
    ),
  );
  assert.equal(
    harnessCalls(runtime, "codex").some((call) => call.includes("personal-mcp")),
    false,
  );
});

test("skips a harness whose CLI is not installed", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home);
  runtime.installedCommands.delete("grok");
  runtime.installedCommands.delete("cursor-agent");

  assert.equal(main([], runtime), 0);
  assert.match(runtime.stdout.value, /Skipping Grok MCP servers: 'grok' is not installed/);
  assert.match(runtime.stdout.value, /Skipping Cursor MCP servers: 'cursor-agent' is not installed/);
  assert.deepEqual(harnessCalls(runtime, "grok"), []);
});

test("reports every failing command with a redacted diagnostic", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, {
    failures: new Map([
      [
        "codex mcp add shared-mcp --url https://mcp.fixture.test/mcp",
        { stdout: "", stderr: "connection refused\ntoken=stderr-secret" },
      ],
    ]),
  });

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /MCP sync failed for 1 command:/);
  assert.match(runtime.stderr.value, /Codex: mcp add shared-mcp --url https:\/\/mcp\.fixture\.test\/mcp \(exit 1\)/);
  assert.match(runtime.stderr.value, /token=\[REDACTED\]/);
  assert.doesNotMatch(runtime.stderr.value, /stderr-secret/);
  assert.doesNotMatch(runtime.stdout.value, /Done\./);
});

test("refuses profiles without agent setup before touching a harness", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, { profile: "assistant" });

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /MCP sync failed: Profile resolution failed/);
  assert.equal(runtime.calls.length, 1);
});

test("rejects unknown arguments and prints help without applying", () => {
  const { repoDir, home } = createFixture();
  const rejected = new FixtureRuntime(repoDir, home);
  assert.equal(main(["--update"], rejected), 2);
  assert.match(rejected.stderr.value, /Unknown argument: --update/);
  assert.equal(rejected.calls.length, 0);

  const helped = new FixtureRuntime(repoDir, home);
  assert.equal(main(["--help"], helped), 0);
  assert.match(helped.stdout.value, /Usage: \.\/scripts\/agents\/mcps\.ts \[--profile PROFILE\]/);
  assert.equal(helped.calls.length, 0);
});

test("ships the tailnet executor on the personal layer only", () => {
  const developer = readServers(join(repoRoot, "scripts/agents/mcps/developer.json"));
  const workstation = readServers(join(repoRoot, "scripts/agents/mcps/workstation.json"));
  const devbox = readServers(join(repoRoot, "scripts/agents/mcps/devbox.json"));
  const personal = readServers(join(repoRoot, "scripts/agents/mcps/personal.json"));

  assert.deepEqual(developer, []);
  assert.deepEqual(workstation, []);
  assert.deepEqual(devbox, []);
  assert.deepEqual(
    personal.map((server) => server.name),
    ["uinaf-executor"],
  );
  assert.equal(personal[0]?.url, "https://executor.zebroid-skate.ts.net/mcp");
  assert.deepEqual(personal[0]?.harnesses, HARNESSES);
});

test("the executable TypeScript entrypoint runs the CLI", () => {
  const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "mcps.ts");
  const result = spawnSync(scriptPath, ["unexpected"], { encoding: "utf8" });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: \.\/scripts\/agents\/mcps\.ts \[--profile PROFILE\]/);
  assert.match(result.stderr, /Unknown argument: unexpected/);
});
