import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vite-plus/test";

import { HARNESSES } from "../harness.ts";
import { readLayeredServers, readServers } from "./catalog.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryDirectories: string[] = [];
const fixtureSharedServers = [{ name: "shared-mcp", url: "https://mcp.fixture.test/mcp" }];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function createFixture(): { repoDir: string } {
  const repoDir = mkdtempSync(join(tmpdir(), "dotfiles-mcp-catalog-"));
  temporaryDirectories.push(repoDir);
  mkdirSync(join(repoDir, "agents", "mcps"), { recursive: true });
  writeManifest(repoDir, "developer", fixtureSharedServers);
  for (const layer of ["workstation", "devbox", "personal"]) {
    writeManifest(repoDir, layer, []);
  }
  return { repoDir };
}

function manifestPath(repoDir: string, layer: string): string {
  return join(repoDir, "agents", "mcps", `${layer}.json`);
}

function writeManifest(repoDir: string, layer: string, servers: unknown): void {
  writeFileSync(manifestPath(repoDir, layer), JSON.stringify({ servers }, null, 2));
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
  assert.throws(
    () => readServers(manifestPath(repoDir, "developer")),
    /harnesses must be a unique/,
  );
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

test("every real MCP manifest parses", () => {
  for (const layer of ["developer", "workstation", "devbox", "personal"]) {
    readServers(join(repoRoot, `agents/mcps/${layer}.json`));
  }
});

test("rejects reserved MCP server names", () => {
  const { repoDir } = createFixture();
  writeManifest(repoDir, "developer", [{ name: "__proto__", url: "https://mcp.fixture.test/mcp" }]);
  assert.throws(() => readServers(manifestPath(repoDir, "developer")), /safe server name/);
});

test("local overlay servers append after profile layers and reject conflicts", () => {
  const { repoDir } = createFixture();
  const path = join(repoDir, "agents", "local.json");
  writeFileSync(
    path,
    JSON.stringify({
      servers: [
        { name: "local-mcp", url: "https://local.fixture.test/mcp", harnesses: ["claude"] },
      ],
    }),
    { mode: 0o600 },
  );
  const result = readLayeredServers(repoDir, "developer", ["developer"]);
  assert.deepEqual(result.layers, ["developer", "local"]);
  assert.equal(result.localPath, path);
  assert.deepEqual(
    result.servers.map((server) => [server.name, server.harnesses]),
    [
      ["shared-mcp", HARNESSES],
      ["local-mcp", ["claude"]],
    ],
  );

  writeFileSync(
    path,
    JSON.stringify({ servers: [{ name: "shared-mcp", url: "https://other.fixture.test/mcp" }] }),
  );
  assert.throws(
    () => readLayeredServers(repoDir, "developer", ["developer"]),
    /shared-mcp is defined more than once/,
  );

  writeFileSync(
    path,
    JSON.stringify({ servers: [{ name: "local-mcp", url: "http://local.fixture.test/mcp" }] }),
  );
  assert.throws(
    () => readLayeredServers(repoDir, "developer", ["developer"]),
    /agents\/local\.json: local-mcp url must use https/,
  );
});
