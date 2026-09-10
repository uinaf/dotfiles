import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { main } from "./doctor.ts";
import { type Runtime } from "./runtime.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

class BufferWriter {
  value = "";
  write(message: string): void {
    this.value += message;
  }
}

type Reply = { status?: number; stdout?: string; stderr?: string };

class FixtureRuntime implements Runtime {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout = new BufferWriter();
  readonly stderr = new BufferWriter();
  readonly installedCommands = new Set(["claude", "codex", "cursor-agent", "grok", "opencode", "sh"]);
  readonly repoDir: string;
  readonly replies: ReadonlyMap<string, Reply>;

  constructor(repoDir: string, home: string, replies: ReadonlyMap<string, Reply>) {
    this.repoDir = repoDir;
    this.env = { HOME: home, PWD: "/fixture/project" };
    this.replies = replies;
  }

  commandExists(command: string): boolean {
    return this.installedCommands.has(command);
  }

  run(command: string, args: readonly string[]) {
    if (command.endsWith("/resolve-profile.ts")) return { status: 0, stdout: "workstation\n", stderr: "" };
    const reply = this.replies.get(`${command} ${args.join(" ")}`) ?? {};
    return { status: reply.status ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
  }
}

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { force: true, recursive: true });
});

function createFixture(): { repoDir: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-agents-doctor-"));
  temporaryDirectories.push(root);
  const repoDir = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(join(repoDir, "chezmoi/.chezmoidata"), { recursive: true });
  mkdirSync(join(repoDir, "scripts/agents/mcps"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(repoDir, "chezmoi/.chezmoidata/profiles.json"),
    readFileSync(join(repoRoot, "chezmoi/.chezmoidata/profiles.json")),
  );
  for (const layer of ["developer", "workstation", "devbox", "personal"]) {
    writeFileSync(
      join(repoDir, `scripts/agents/mcps/${layer}.json`),
      JSON.stringify({
        servers: layer === "developer" ? [{ name: "shared-mcp", url: "https://mcp.fixture.test/mcp" }] : [],
      }),
    );
  }
  return { repoDir, home };
}

const healthy = new Map<string, Reply>([
  ["claude mcp get shared-mcp", { stdout: "shared-mcp:\n  Status: ✔ Connected\n  URL: https://mcp.fixture.test/mcp\n" }],
  ["codex mcp list --json", { stdout: JSON.stringify([{ name: "shared-mcp", auth_status: "o_auth" }]) }],
  ["cursor-agent mcp list", { stdout: "hindsight: ready\nshared-mcp: ready\n" }],
  ["opencode mcp list", { stdout: "●  ✓ shared-mcp [90mconnected\n│      https://mcp.fixture.test/mcp\n" }],
  [
    "grok mcp doctor --json",
    { stdout: JSON.stringify({ servers: [{ name: "shared-mcp", healthy: true, checks: [{ label: "9 tools discovered", passed: true }] }] }) },
  ],
  ["sh -c command -v grok", { stdout: "/opt/homebrew/bin/grok\n" }],
]);

test("reports every harness usable and exits 0", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, healthy);
  assert.equal(main([], runtime), 0);
  assert.match(runtime.stdout.value, /ok {4}Claude Code: shared-mcp - connected/);
  assert.match(runtime.stdout.value, /\? {5}Codex: shared-mcp - o_auth/);
  assert.match(runtime.stdout.value, /ok {4}Cursor: shared-mcp - ready in \/fixture\/project/);
  assert.match(runtime.stdout.value, /ok {4}OpenCode: shared-mcp - connected/);
  assert.match(runtime.stdout.value, /ok {4}Grok: shared-mcp - 9 tools discovered/);
  assert.match(runtime.stdout.value, /All managed MCP servers are usable\./);
  assert.doesNotMatch(runtime.stdout.value, /repair:/);
});

test("names the login command for each expired harness and exits 1", () => {
  const { repoDir, home } = createFixture();
  const replies = new Map(healthy);
  replies.set("claude mcp get shared-mcp", { stdout: "shared-mcp:\n  Status: ! Needs authentication\n" });
  replies.set("cursor-agent mcp list", { stdout: "shared-mcp: requires_authentication\n" });
  replies.set("opencode mcp list", { stdout: "●  ⚠ shared-mcp needs authentication\n" });
  replies.set("grok mcp doctor --json", {
    stdout: JSON.stringify({
      servers: [{
        name: "shared-mcp",
        healthy: false,
        checks: [{ label: "handshake failed", passed: false, detail: "error: Auth required, when send initialize request" }],
      }],
    }),
  });
  const runtime = new FixtureRuntime(repoDir, home, replies);
  assert.equal(main([], runtime), 1);
  assert.match(runtime.stdout.value, /LOGIN Claude Code: shared-mcp[^\n]*\n {6}repair: claude mcp login shared-mcp/);
  assert.match(runtime.stdout.value, /LOGIN Cursor: shared-mcp[^\n]*\n {6}repair: cursor-agent mcp login shared-mcp/);
  assert.match(runtime.stdout.value, /LOGIN OpenCode: shared-mcp[^\n]*\n {6}repair: opencode mcp auth shared-mcp/);
  assert.match(runtime.stdout.value, /LOGIN Grok: shared-mcp[^\n]*\n {6}repair: \.\/scripts\/agents\/grok-mcp-login\.ts shared-mcp/);
  assert.match(runtime.stdout.value, /4 MCP server state\(s\) need attention\./);
});

test("flags Grok config parse errors and installation drift", () => {
  const { repoDir, home } = createFixture();
  mkdirSync(join(home, ".grok", "bin"), { recursive: true });
  const replies = new Map(healthy);
  replies.set("grok mcp doctor --json", {
    stdout: "",
    stderr: "ERROR config toml has syntax errors: TOML parse error at line 66, column 14: duplicate key file=/h/.grok/config.toml",
  });
  replies.set("sh -c command -v grok", { stdout: "/h/.local/share/mise/shims/grok\n" });
  const runtime = new FixtureRuntime(repoDir, home, replies);
  assert.equal(main([], runtime), 1);
  assert.match(runtime.stdout.value, /FAIL {2}Grok: shared-mcp - ~\/\.grok\/config\.toml does not parse: TOML parse error/);
  assert.match(runtime.stdout.value, /FAIL {2}Grok: install - ~\/\.grok\/bin exists/);
  assert.match(runtime.stdout.value, /FAIL {2}Grok: install - grok resolves to \/h\/\.local\/share\/mise\/shims\/grok/);
  assert.match(runtime.stdout.value, /repair: npm uninstall -g @xai-official\/grok/);
});

test("skips harnesses that are not installed", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, healthy);
  runtime.installedCommands.delete("grok");
  runtime.installedCommands.delete("cursor-agent");
  assert.equal(main([], runtime), 0);
  assert.match(runtime.stdout.value, /Skipping Grok: 'grok' is not installed/);
  assert.doesNotMatch(runtime.stdout.value, /Cursor: shared-mcp/);
});
