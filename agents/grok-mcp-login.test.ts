import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { serverUrlFromConfig, writeCredentials } from "./grok-mcp-login.ts";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { force: true, recursive: true });
});

test("reads the url of the named server from config.toml", () => {
  const toml = [
    "[mcp_servers.hindsight]",
    'command = "node"',
    "",
    "[mcp_servers.remote-mcp]",
    'url = "https://executor.example/mcp"',
    "enabled = true",
    "",
  ].join("\n");
  assert.equal(serverUrlFromConfig(toml, "remote-mcp"), "https://executor.example/mcp");
  assert.equal(serverUrlFromConfig(toml, "hindsight"), undefined);
  assert.equal(serverUrlFromConfig(toml, "missing"), undefined);
});

test("writes the native key plus legacy keys with owner-only permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-grok-login-"));
  temporaryDirectories.push(root);
  const path = join(root, "mcp_credentials.json");
  writeCredentials(path, "srv", "https://srv.example/mcp", {
    client_id: "cid",
    issuer: "https://srv.example",
    token_response: { access_token: "a", refresh_token: "r", expires_in: 3600 },
    granted_scopes: ["openid"],
    token_received_at: 1700000000,
  });
  const stored = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(stored["srv:https://srv.example/mcp"].token_received_at, 1700000000);
  assert.equal(stored.srv.token_received_at, 1700000000000);
  assert.equal(stored["https://srv.example/mcp"].client_id, "cid");
  assert.equal(statSync(path).mode & 0o777, 0o600);
});
