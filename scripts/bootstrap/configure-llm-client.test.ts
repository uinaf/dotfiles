#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { gatewayEdits, parseClientConfig } from "./configure-llm-client.ts";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "configure-llm-client.ts");
const codexInstalled = spawnSync("codex", ["--version"], { stdio: "ignore" }).status === 0;

const validConfig = {
  version: 1 as const,
  secretFile: "/Users/example/vault/coding.sops.env",
  gatewayBaseUrl: "https://gateway.example/v1",
  cursorAgentBin: "/Users/example/.local/bin/agent",
};

test("client config is strict and provider edits use command-backed Responses auth", () => {
  assert.deepEqual(parseClientConfig(JSON.stringify(validConfig)), validConfig);
  assert.throws(
    () => parseClientConfig(JSON.stringify({ ...validConfig, token: "secret" })),
    /must contain exactly/,
  );
  assert.throws(
    () => parseClientConfig(JSON.stringify({ ...validConfig, gatewayBaseUrl: "http://gateway.example/v1" })),
    /HTTPS \/v1 URL/,
  );

  const edits = gatewayEdits(validConfig, "/Users/example/.local/libexec/dotfiles/llm-client-credential");
  assert.equal(edits.some((edit) => edit.keyPath === "forced_login_method"), false);
  assert.ok(edits.some((edit) => edit.keyPath === "model_providers.llm_gateway.wire_api" && edit.value === "responses"));
  assert.ok(edits.some((edit) => edit.keyPath === "model_providers.llm_gateway.auth.command"));
  assert.ok(edits.some((edit) => edit.keyPath === "model_providers.llm_gateway.auth.args" && Array.isArray(edit.value) && edit.value[0] === "gateway"));
  assert.equal(edits.some((edit) => edit.keyPath.includes("env_key") || edit.keyPath.includes("bearer_token")), false);
});

test("apply, check, Cursor status, and rollback preserve saved login state", { skip: !codexInstalled }, () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-llm-client-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const codexHome = join(home, ".codex");
  const configDir = join(home, ".config/dotfiles");
  const clientConfig = join(configDir, "llm-client.json");
  const secretFile = join(root, "coding.sops.env");
  const cursorBin = join(bin, "cursor-agent");
  const originalCodex = '# retained\nforced_login_method = "chatgpt"\n';
  const originalAuth = '{"tokens":"saved-login-state"}\n';
  const cursorKey = "crsr_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  const gatewayKey = "0123456789abcdefghijklmnopqrstuvwxyz_ABCD";

  try {
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), originalCodex, { mode: 0o600 });
    writeFileSync(join(codexHome, "auth.json"), originalAuth, { mode: 0o600 });
    writeFileSync(secretFile, "encrypted fixture\n", { mode: 0o600 });
    writeFileSync(clientConfig, `${JSON.stringify({ ...validConfig, secretFile, cursorAgentBin: cursorBin })}\n`, { mode: 0o600 });
    writeFileSync(cursorBin, '#!/usr/bin/env bash\n[ "${1:-}" = models ] || exit 2\n', { mode: 0o700 });
    writeFileSync(join(bin, "sops"), `#!/usr/bin/env bash
case "\${1:-}" in
  filestatus) printf '{"encrypted":true}\\n' ;;
  decrypt) printf '{"CURSOR_API_KEY":"${cursorKey}","CLIPROXYAPI_CLIENT_API_KEY":"${gatewayKey}"}\\n' ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });

    const env = {
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome,
      LLM_CLIENT_CONFIG: clientConfig,
      PATH: `${bin}:${process.env.PATH || ""}`,
    };
    const run = (...args: string[]) => spawnSync(script, args, { encoding: "utf8", env });

    const apply = run();
    assert.equal(apply.status, 0, apply.stderr);
    assert.equal(readFileSync(join(codexHome, "auth.json"), "utf8"), originalAuth);
    assert.equal(statSync(join(codexHome, "config.toml")).mode & 0o777, 0o600);
    const appliedCodex = readFileSync(join(codexHome, "config.toml"), "utf8");
    assert.match(appliedCodex, /model_provider = "llm_gateway"/);
    assert.match(appliedCodex, /forced_login_method = "chatgpt"/);

    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(join(codexHome, "config.toml.llm-client.backup"), "utf8"), originalCodex);

    const check = run("--check");
    assert.equal(check.status, 0, check.stderr);
    const cursorStatus = spawnSync(join(home, ".local/bin/cursor-agent-api"), ["status"], { encoding: "utf8", env });
    assert.equal(cursorStatus.status, 0, cursorStatus.stderr);
    assert.equal(cursorStatus.stdout.trim(), "API key authenticated");
    const cursorLogin = spawnSync(join(home, ".local/bin/cursor-agent-api"), ["login", "--help"], { encoding: "utf8", env });
    assert.notEqual(cursorLogin.status, 0);
    assert.match(cursorLogin.stderr, /saved-login changes are disabled/);

    const rollback = run("--rollback");
    assert.equal(rollback.status, 0, rollback.stderr);
    assert.equal(readFileSync(join(codexHome, "config.toml"), "utf8"), originalCodex);
    assert.equal(readFileSync(join(codexHome, "auth.json"), "utf8"), originalAuth);
    assert.equal(existsSync(join(home, ".local/bin/cursor-agent-api")), false);
    assert.equal(existsSync(join(home, ".local/libexec/dotfiles/llm-client-credential")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
