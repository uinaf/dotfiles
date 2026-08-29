#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertCursorAgentBinSafe,
  claudeGatewayBaseUrl,
  claudeGatewaySettings,
  gatewayEdits,
  grokGatewaySettings,
  parseGatewayConfig,
} from "./configure-llm-gateway.ts";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "configure-llm-gateway.ts");
const codexInstalled = spawnSync("codex", ["--version"], { stdio: "ignore" }).status === 0;

function fixturePath(bin: string): string {
  const ambient = (process.env.PATH || "").split(":").filter((entry) => entry && !entry.endsWith("/mise/shims"));
  return [bin, ...ambient].join(":");
}

const validConfig = {
  version: 3 as const,
  credentials: {
    gatewai: "0123456789abcdefghijklmnopqrstuvwxyz_ABCD",
    bifrost: "sk-bf-11111111-1111-4111-8111-111111111111",
    cursor: "crsr_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-",
  },
  gatewaiBaseUrl: "https://gatewai.example/v1",
  bifrostBaseUrl: "https://bifrost.example/v1",
  cursorAgentBin: "/Users/example/.local/bin/agent",
};

test("gateway config is strict and provider edits use command-backed Responses auth", () => {
  const config = parseGatewayConfig(JSON.stringify(validConfig));
  assert.throws(
    () => parseGatewayConfig(JSON.stringify({ ...validConfig, token: "secret" })),
    /unknown field/,
  );
  assert.throws(
    () => parseGatewayConfig(JSON.stringify({ ...validConfig, gatewaiBaseUrl: "http://gatewai.example/v1" })),
    /HTTPS \/v1 URL/,
  );
  assert.deepEqual(
    parseGatewayConfig(JSON.stringify({ ...validConfig, preservedLogins: ["claude"] })).preservedLogins,
    ["claude"],
  );
  assert.throws(
    () => parseGatewayConfig(JSON.stringify({ ...validConfig, preservedLogins: ["claude", "claude"] })),
    /preservedLogins must list unique clients/,
  );
  assert.throws(
    () => parseGatewayConfig(JSON.stringify({ ...validConfig, preservedLogins: ["opencode"] })),
    /preservedLogins must list unique clients/,
  );

  const edits = gatewayEdits(config, "/Users/example/.local/libexec/dotfiles/llm-gateway-credential");
  assert.equal(edits.some((edit) => edit.keyPath === "forced_login_method"), false);
  assert.ok(edits.some((edit) => edit.keyPath === "features.apps" && edit.value === false));
  assert.ok(edits.some((edit) => edit.keyPath === "mcp_servers.node_repl" && edit.value === null));
  assert.ok(edits.some((edit) => edit.keyPath === "model_providers.gatewai.name" && edit.value === "Gatewai"));
  assert.ok(edits.some((edit) => edit.keyPath === "model_providers.bifrost.name" && edit.value === "Bifrost"));
  assert.ok(edits.some((edit) => edit.keyPath === "model_providers.gatewai.auth.args" && Array.isArray(edit.value) && edit.value[0] === "gatewai"));
  assert.ok(edits.some((edit) => edit.keyPath === "model_providers.bifrost.auth.args" && Array.isArray(edit.value) && edit.value[0] === "bifrost"));
  assert.equal(edits.some((edit) => edit.keyPath.includes("env_key") || edit.keyPath.includes("bearer_token")), false);

  assert.equal(claudeGatewayBaseUrl(config.gatewaiBaseUrl), "https://gatewai.example");
  assert.deepEqual(
    claudeGatewaySettings('{"theme":"dark","env":{"KEEP":"yes"}}', config.gatewaiBaseUrl, "/Users/example/.local/libexec/dotfiles/llm-gateway-credential"),
    {
      theme: "dark",
      apiKeyHelper: "/Users/example/.local/libexec/dotfiles/llm-gateway-credential gatewai",
      env: { KEEP: "yes", ANTHROPIC_BASE_URL: "https://gatewai.example" },
    },
  );
  assert.throws(
    () => claudeGatewaySettings('{"env":{"ANTHROPIC_API_KEY":"conflict"}}', validConfig.gatewaiBaseUrl, "/helper"),
    /conflicts with the gateway/,
  );

  assert.throws(
    () => assertCursorAgentBinSafe("/Users/example/.local/bin/agent", ["/Users/example/.local/bin/agent"]),
    /versioned vendor executable/,
  );

  assert.match(grokGatewaySettings("[ui]\ntheme = \"dark\"\n", config.gatewaiBaseUrl, "/helper"), /models_base_url = "https:\/\/gatewai\.example\/v1"/);
  assert.match(grokGatewaySettings("", config.gatewaiBaseUrl, "/helper"), /auth_provider_command = "\/helper gatewai"/);
  assert.throws(
    () => grokGatewaySettings('[auth]\nauth_provider_command = "/other"\n', config.gatewaiBaseUrl, "/helper"),
    /conflicts with gateway section: auth/,
  );
});

test("apply preserves login state, explicit retirement clears it, and rollback remains honest", { skip: !codexInstalled }, () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-llm-gateway-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const codexHome = join(home, ".codex");
  const configDir = join(home, ".config/dotfiles");
  const gatewayConfig = join(configDir, "llm-gateway.json");
  const claudeSettingsPath = join(home, ".claude/settings.json");
  const cursorBin = join(home, ".local/share/cursor-agent/versions/test/cursor-agent");
  const cursorCommands = [join(home, ".local/bin/cursor-agent"), join(home, ".local/bin/agent")];
  const originalCursorTargets = ["../share/cursor-agent/versions/test/cursor-agent", "../share/cursor-agent/versions/test/cursor-agent"];
  const originalCodex = '# retained\nforced_login_method = "chatgpt"\n';
  const originalAuth = '{"tokens":"saved-login-state"}\n';
  const originalClaudeAuth = '{"oauth":"saved-login-state"}\n';
  const originalCursorAuth = '{"accessToken":"saved-login-state"}\n';
  const originalClaudeSettings = '{"permissions":{"defaultMode":"auto"},"env":{"KEEP":"yes"},"theme":"dark"}\n';
  try {
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(dirname(cursorBin), { recursive: true });
    mkdirSync(dirname(cursorCommands[0]), { recursive: true });
    mkdirSync(dirname(claudeSettingsPath), { recursive: true });
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), originalCodex, { mode: 0o600 });
    writeFileSync(join(codexHome, "auth.json"), originalAuth, { mode: 0o600 });
    writeFileSync(join(home, ".claude/.credentials.json"), originalClaudeAuth, { mode: 0o600 });
    writeFileSync(join(home, ".cursor/auth.json"), originalCursorAuth, { mode: 0o600 });
    writeFileSync(claudeSettingsPath, originalClaudeSettings, { mode: 0o600 });
    writeFileSync(gatewayConfig, `${JSON.stringify({ ...validConfig, cursorAgentBin: cursorBin })}\n`, { mode: 0o600 });
    writeFileSync(cursorBin, `#!/usr/bin/env bash
case "\${1:-}" in
  models) exit 0 ;;
  logout) rm -f "$HOME/.cursor/auth.json" ;;
  --version) printf '2026.08.11-e8db854\\n' ;;
  acp)
    while IFS= read -r line; do
      printf '%s\\n' "\$line" >> "\${ACP_REQUEST_LOG:?}"
      method="\$(printf '%s' "\$line" | jq -r '.method // empty')"
      id="\$(printf '%s' "\$line" | jq -c '.id')"
      if [ "\$method" = authenticate ]; then
        printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32602,"message":"browser login"}}\\n' "\$id"
      else
        printf '{"jsonrpc":"2.0","id":%s,"result":{}}\\n' "\$id"
      fi
    done
    ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
    for (const [index, command] of cursorCommands.entries()) symlinkSync(originalCursorTargets[index], command);
    writeFileSync(join(bin, "claude"), `#!/usr/bin/env bash
set -euo pipefail
[ "\${1:-}" = auth ] && [ "\${2:-}" = logout ] || exit 2
rm -f "$HOME/.claude/.credentials.json"
`, { mode: 0o700 });

    const env = {
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome,
      LLM_GATEWAY_CONFIG: gatewayConfig,
      PATH: fixturePath(bin),
    };
    const run = (...args: string[]) => spawnSync(script, args, { encoding: "utf8", env });

    const apply = run();
    assert.equal(apply.status, 0, apply.stderr);
    assert.equal(readFileSync(join(codexHome, "auth.json"), "utf8"), originalAuth);
    assert.equal(statSync(join(codexHome, "config.toml")).mode & 0o777, 0o600);
    const appliedCodex = readFileSync(join(codexHome, "config.toml"), "utf8");
    assert.match(appliedCodex, /model_provider = "gatewai"/);
    assert.match(appliedCodex, /\[model_providers\.bifrost\]/);
    assert.match(appliedCodex, /forced_login_method = "chatgpt"/);
    const appliedClaude = JSON.parse(readFileSync(claudeSettingsPath, "utf8")) as {
      apiKeyHelper: string;
      env: Record<string, string>;
      permissions: Record<string, string>;
      theme: string;
    };
    assert.equal(appliedClaude.apiKeyHelper, `${join(home, ".local/libexec/dotfiles/llm-gateway-credential")} gatewai`);
    assert.equal(appliedClaude.env.ANTHROPIC_BASE_URL, "https://gatewai.example");
    assert.equal(appliedClaude.env.KEEP, "yes");
    assert.equal(appliedClaude.permissions.defaultMode, "auto");
    assert.equal(appliedClaude.theme, "dark");
    assert.equal(statSync(claudeSettingsPath).mode & 0o777, 0o600);
    for (const command of cursorCommands) {
      assert.equal(lstatSync(command).isSymbolicLink(), false);
      assert.equal(statSync(command).mode & 0o777, 0o700);
    }
    const state = JSON.parse(readFileSync(join(configDir, "llm-gateway-state.json"), "utf8")) as { version: number; authRetired: boolean; cursorCommands: Array<{ target: string }> };
    assert.equal(state.version, 6);
    assert.equal(state.authRetired, false);
    assert.deepEqual(state.cursorCommands.map((command) => command.target), originalCursorTargets);
    assert.equal(statSync(join(home, ".local/libexec/dotfiles/cursor-acp-api-key-auth")).mode & 0o777, 0o700);
    assert.equal(statSync(join(home, ".local/libexec/dotfiles/cursor-agent-api")).mode & 0o777, 0o700);
    const bifrostCredential = spawnSync(join(home, ".local/libexec/dotfiles/llm-gateway-credential"), ["bifrost"], {
      encoding: "utf8",
      env,
    });
    assert.equal(bifrostCredential.status, 0, bifrostCredential.stderr);
    assert.equal(bifrostCredential.stdout.trim(), validConfig.credentials.bifrost);

    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(join(codexHome, "config.toml.llm-gateway.backup"), "utf8"), originalCodex);
    assert.equal(readFileSync(`${claudeSettingsPath}.llm-gateway.backup`, "utf8"), originalClaudeSettings);

    const check = run("--check");
    assert.equal(check.status, 0, check.stderr);
    for (const command of [
      join(home, ".local/libexec/dotfiles/cursor-agent-api"),
      join(home, ".local/bin/cursor-agent-api"),
      ...cursorCommands,
    ]) {
      const cursorStatus = spawnSync(command, ["status"], { encoding: "utf8", env });
      assert.equal(cursorStatus.status, 0, cursorStatus.stderr);
      assert.equal(cursorStatus.stdout.trim(), "API key authenticated");
      const cursorAbout = spawnSync(command, ["about"], { encoding: "utf8", env });
      assert.equal(cursorAbout.status, 0, cursorAbout.stderr);
      assert.match(cursorAbout.stdout, /CLI Version\s{2,}2026\.08\.11-e8db854/);
      assert.match(cursorAbout.stdout, /User Email\s{2,}api-key@local/);
      const cursorAboutJson = spawnSync(command, ["about", "--format", "json"], { encoding: "utf8", env });
      assert.equal(cursorAboutJson.status, 0, cursorAboutJson.stderr);
      assert.deepEqual(JSON.parse(cursorAboutJson.stdout), {
        cliVersion: "2026.08.11-e8db854",
        userEmail: "api-key@local",
      });
      const cursorLogin = spawnSync(command, ["login", "--help"], { encoding: "utf8", env });
      assert.notEqual(cursorLogin.status, 0);
      assert.match(cursorLogin.stderr, /saved-login changes are disabled/);
      const acpLog = join(root, `acp-${command.replace(/\//g, "_")}.log`);
      const cursorAcp = spawnSync(command, ["acp"], {
        encoding: "utf8",
        env: { ...env, ACP_REQUEST_LOG: acpLog },
        input: [
          '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
          '{"jsonrpc":"2.0","id":2,"method":"authenticate","params":{"methodId":"cursor_login"}}',
          "",
        ].join("\n"),
      });
      assert.equal(cursorAcp.status, 0, cursorAcp.stderr);
      assert.match(cursorAcp.stdout, /"id":1,"result":\{\}/);
      assert.match(cursorAcp.stdout, /"id":2,"result":\{\}/);
      assert.doesNotMatch(cursorAcp.stdout, /browser login/);
      assert.match(readFileSync(acpLog, "utf8"), /"method":"initialize"/);
      assert.doesNotMatch(readFileSync(acpLog, "utf8"), /"method":"authenticate"/);
    }

    const updatedCursorBin = join(home, ".local/share/cursor-agent/versions/updated/cursor-agent");
    mkdirSync(dirname(updatedCursorBin), { recursive: true });
    writeFileSync(updatedCursorBin, `#!/usr/bin/env bash
case "\${1:-}" in
  models) exit 0 ;;
  --version) printf '2026.08.25-3e8eec8\\n' ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
    for (const command of cursorCommands) {
      rmSync(command, { force: true });
      symlinkSync(updatedCursorBin, command);
    }
    const stableAfterUpdate = spawnSync(join(home, ".local/libexec/dotfiles/cursor-agent-api"), ["about", "--format", "json"], {
      encoding: "utf8",
      env,
    });
    assert.equal(stableAfterUpdate.status, 0, stableAfterUpdate.stderr);
    assert.deepEqual(JSON.parse(stableAfterUpdate.stdout), {
      cliVersion: "2026.08.25-3e8eec8",
      userEmail: "api-key@local",
    });
    const repairAfterUpdate = run();
    assert.equal(repairAfterUpdate.status, 0, repairAfterUpdate.stderr);
    for (const command of cursorCommands) assert.equal(lstatSync(command).isSymbolicLink(), false);

    const retire = run("--retire-auth");
    assert.equal(retire.status, 0, retire.stderr);
    assert.equal(existsSync(join(codexHome, "auth.json")), false);
    assert.equal(existsSync(join(home, ".claude/.credentials.json")), false);
    assert.equal(existsSync(join(home, ".cursor/auth.json")), false);
    assert.doesNotMatch(readFileSync(join(codexHome, "config.toml"), "utf8"), /forced_login_method/);
    const retiredState = JSON.parse(readFileSync(join(configDir, "llm-gateway-state.json"), "utf8")) as { authRetired: boolean };
    assert.equal(retiredState.authRetired, true);
    const retiredCheck = run("--check");
    assert.equal(retiredCheck.status, 0, retiredCheck.stderr);
    assert.match(retiredCheck.stdout, /auth-retired=true/);

    writeFileSync(join(codexHome, "auth.json"), originalAuth, { mode: 0o600 });
    writeFileSync(join(home, ".claude/.credentials.json"), originalClaudeAuth, { mode: 0o600 });
    writeFileSync(join(home, ".cursor/auth.json"), originalCursorAuth, { mode: 0o600 });
    const repeatedRetire = run("--retire-auth");
    assert.equal(repeatedRetire.status, 0, repeatedRetire.stderr);
    assert.match(repeatedRetire.stdout, /retired returned coding vendor login state/);
    assert.equal(existsSync(join(codexHome, "auth.json")), false);
    assert.equal(existsSync(join(home, ".claude/.credentials.json")), false);
    assert.equal(existsSync(join(home, ".cursor/auth.json")), false);
    const repeatedCheck = run("--check");
    assert.equal(repeatedCheck.status, 0, repeatedCheck.stderr);

    const rollback = run("--rollback");
    assert.equal(rollback.status, 0, rollback.stderr);
    assert.equal(readFileSync(join(codexHome, "config.toml"), "utf8"), originalCodex);
    assert.equal(existsSync(join(codexHome, "auth.json")), false);
    assert.equal(existsSync(join(home, ".claude/.credentials.json")), false);
    assert.equal(existsSync(join(home, ".cursor/auth.json")), false);
    assert.match(rollback.stdout, /requires reauthentication/);
    assert.equal(readFileSync(claudeSettingsPath, "utf8"), originalClaudeSettings);
    assert.equal(existsSync(join(home, ".local/bin/cursor-agent-api")), false);
    assert.equal(existsSync(join(home, ".local/libexec/dotfiles/cursor-agent-api")), false);
    assert.equal(existsSync(join(home, ".local/libexec/dotfiles/cursor-acp-api-key-auth")), false);
    assert.equal(existsSync(join(home, ".local/libexec/dotfiles/llm-gateway-credential")), false);
    for (const [index, command] of cursorCommands.entries()) {
      assert.equal(lstatSync(command).isSymbolicLink(), true);
      assert.equal(readlinkSync(command), originalCursorTargets[index]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gateway-only payload configures canonical Grok and retirement discards its saved vendor login", { skip: !codexInstalled }, () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-llm-gateway-grok-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const codexHome = join(home, ".codex");
  const configDir = join(home, ".config/dotfiles");
  const gatewayConfig = join(configDir, "llm-gateway.json");
  const claudeSettingsPath = join(home, ".claude/settings.json");
  const grokBin = join(bin, "grok-vendor");
  const grokConfig = join(home, ".grok/config.toml");
  const grokLogin = join(home, ".grok/auth.json");
  const originalCodex = '# retained\nforced_login_method = "chatgpt"\n';
  const originalClaude = '{"theme":"dark"}\n';
  const originalGrokConfig = '[ui]\ntheme = "dark"\n';
  const originalGrokLogin = '{"access_token":"saved-vendor-login"}\n';

  try {
    for (const path of [codexHome, configDir, bin, dirname(claudeSettingsPath), dirname(grokLogin)]) mkdirSync(path, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), originalCodex, { mode: 0o600 });
    writeFileSync(claudeSettingsPath, originalClaude, { mode: 0o600 });
    writeFileSync(grokConfig, originalGrokConfig, { mode: 0o600 });
    writeFileSync(grokLogin, originalGrokLogin, { mode: 0o600 });
    writeFileSync(gatewayConfig, `${JSON.stringify({
      version: 3,
      credentials: { gatewai: validConfig.credentials.gatewai, bifrost: validConfig.credentials.bifrost },
      gatewaiBaseUrl: "https://gatewai.example/v1",
      bifrostBaseUrl: "https://bifrost.example/v1",
      grokBin,
    })}\n`, { mode: 0o600 });
    writeFileSync(grokBin, `#!/usr/bin/env bash
if [ "\${1:-}" = login ]; then
  printf '{"access_token":"gateway-token"}\\n' > "$HOME/.grok/auth.json"
  chmod 600 "$HOME/.grok/auth.json"
  exit 0
fi
printf "%s\\n" "$*"
`, { mode: 0o700 });
    writeFileSync(join(bin, "claude"), '#!/usr/bin/env bash\n[ "${1:-}" = auth ] && [ "${2:-}" = logout ]\n', { mode: 0o700 });

    const env = {
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome,
      LLM_GATEWAY_CONFIG: gatewayConfig,
      PATH: fixturePath(bin),
    };
    const run = (...args: string[]) => spawnSync(script, args, { encoding: "utf8", env });

    const apply = run();
    assert.equal(apply.status, 0, apply.stderr);
    assert.match(apply.stdout, /canonical Grok gateway routing/);
    assert.equal(readFileSync(grokLogin, "utf8"), '{"access_token":"gateway-token"}\n');
    assert.equal(readFileSync(`${grokLogin}.llm-gateway.backup`, "utf8"), originalGrokLogin);
    assert.equal(readFileSync(`${grokConfig}.llm-gateway.backup`, "utf8"), originalGrokConfig);
    assert.equal(existsSync(join(home, ".local/bin/cursor-agent-api")), false);
    assert.equal(existsSync(join(home, ".local/libexec/dotfiles/cursor-agent-api")), false);
    assert.equal(existsSync(join(home, ".local/libexec/dotfiles/cursor-acp-api-key-auth")), false);
    assert.match(readFileSync(grokConfig, "utf8"), /default = "grok-4\.6"/);
    assert.match(readFileSync(grokConfig, "utf8"), /\[ui\]\ntheme = "dark"/);
    const grok = spawnSync(grokBin, ["-p", "hello"], { encoding: "utf8", env });
    assert.equal(grok.status, 0, grok.stderr);
    assert.match(grok.stdout, /-p hello/);

    const state = JSON.parse(readFileSync(join(configDir, "llm-gateway-state.json"), "utf8")) as {
      version: number;
      cursorCommands: unknown[];
      grokEnabled: boolean;
    };
    assert.equal(state.version, 6);
    assert.deepEqual(state.cursorCommands, []);
    assert.equal(state.grokEnabled, true);
    const check = run("--check");
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /Cursor=false, Grok=true/);

    const retire = run("--retire-auth");
    assert.equal(retire.status, 0, retire.stderr);
    assert.equal(existsSync(`${grokLogin}.llm-gateway.backup`), false);
    const retiredState = JSON.parse(readFileSync(join(configDir, "llm-gateway-state.json"), "utf8")) as {
      authRetired: boolean;
      grokAuthExisted: boolean;
      grokAuthBackupPath: string | null;
    };
    assert.equal(retiredState.authRetired, true);
    assert.equal(retiredState.grokAuthExisted, false);
    assert.equal(retiredState.grokAuthBackupPath, null);
    const secondRetire = run("--retire-auth");
    assert.equal(secondRetire.status, 0, secondRetire.stderr);
    assert.match(secondRetire.stdout, /already retired/);

    const rollback = run("--rollback");
    assert.equal(rollback.status, 0, rollback.stderr);
    assert.equal(readFileSync(join(codexHome, "config.toml"), "utf8"), originalCodex);
    assert.equal(readFileSync(claudeSettingsPath, "utf8"), originalClaude);
    assert.equal(readFileSync(grokConfig, "utf8"), originalGrokConfig);
    assert.equal(existsSync(grokLogin), false);
    assert.equal(existsSync(join(home, ".local/bin/grok-gateway")), false);
    assert.equal(existsSync(join(home, ".config/dotfiles/grok-gateway")), false);
    assert.equal(existsSync(`${grokConfig}.llm-gateway.backup`), false);
    assert.equal(existsSync(`${grokLogin}.llm-gateway.backup`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-v6 gateway state fails closed with a re-enroll instruction", { skip: !codexInstalled }, () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-llm-gateway-prev6-"));
  const home = join(root, "home");
  const configDir = join(home, ".config/dotfiles");
  const gatewayConfig = join(configDir, "llm-gateway.json");
  const statePath = join(configDir, "llm-gateway-state.json");

  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(gatewayConfig, `${JSON.stringify({ ...validConfig, cursorAgentBin: undefined, credentials: { gatewai: validConfig.credentials.gatewai, bifrost: validConfig.credentials.bifrost } })}\n`, { mode: 0o600 });
    writeFileSync(statePath, `${JSON.stringify({
      version: 2,
      codexConfigExisted: false,
      codexBackupPath: null,
      cursorCommands: [],
    }, null, 2)}\n`, { mode: 0o600 });

    const env = { ...process.env, HOME: home, LLM_GATEWAY_CONFIG: gatewayConfig };
    for (const args of [[], ["--check"], ["--rollback"]]) {
      const result = spawnSync(script, args, { encoding: "utf8", env });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /roll back and re-enroll pre-v6 hosts/);
    }
    assert.equal(existsSync(statePath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
