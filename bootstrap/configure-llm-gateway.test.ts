#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertCursorAgentBinSafe,
  claudeGatewayBaseUrl,
  claudeGatewaySettings,
  codexGatewaiOverrides,
  gatewayEdits,
  grokGatewaySettings,
  parseGatewayConfig,
  resolveOnPath,
} from "./configure-llm-gateway.ts";
import { codexInstalled, fixturePath, script, validConfig } from "./llm-gateway-fixture.ts";

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
  assert.ok(edits.some((edit) => edit.keyPath === "model_providers.gatewai.supports_websockets" && edit.value === true));
  assert.ok(edits.some((edit) => edit.keyPath === "model_providers.gatewai.http_headers"
    && JSON.stringify(edit.value) === JSON.stringify({ "X-OpenAI-Actor-Authorization": "local-proxy" })));
  const overrides = codexGatewaiOverrides(config, "/Users/example/.local/libexec/dotfiles/llm-gateway-credential");
  assert.ok(overrides.includes('model_providers.gatewai.http_headers={"X-OpenAI-Actor-Authorization" = "local-proxy"}'));
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

  assert.equal(resolveOnPath("cursor-agent", ""), null);
  assert.equal(resolveOnPath("cursor-agent", "relative/bin"), null);
  assert.equal(resolveOnPath("definitely-not-a-command", "/usr/bin:/bin"), null);
  assert.equal(resolveOnPath("sh", "/nonexistent::/bin"), "/bin/sh");

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
  const cursorCommands = [join(home, ".local/bin/cursor-agent")];
  // Cursor's installer ships this name too, but Homebrew's Grok cask wins on PATH
  // and dotfiles must leave it exactly as the vendor left it.
  const agentCommand = join(home, ".local/bin/agent");
  const launcherDir = join(home, ".local/libexec/dotfiles/bin");
  const launcherCommand = join(launcherDir, "cursor-agent");
  const decoyDir = join(root, "decoy");
  const originalCursorTargets = ["../share/cursor-agent/versions/test/cursor-agent"];
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
    symlinkSync("../share/cursor-agent/versions/test/cursor-agent", agentCommand);
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
      PATH: [launcherDir, fixturePath(bin)].join(":"),
    };
    const run = (...args: string[]) => spawnSync(script, args, { encoding: "utf8", env });

    const apply = run();
    assert.equal(apply.status, 0, apply.stderr);
    assert.equal(readFileSync(join(codexHome, "auth.json"), "utf8"), originalAuth);
    assert.equal(statSync(join(codexHome, "config.toml")).mode & 0o777, 0o600);
    const appliedCodex = readFileSync(join(codexHome, "config.toml"), "utf8");
    assert.match(appliedCodex, /model_provider = "gatewai"/);
    assert.match(appliedCodex, /supports_websockets = true/);
    assert.match(appliedCodex, /X-OpenAI-Actor-Authorization = "local-proxy"/);
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
    const state = JSON.parse(readFileSync(join(configDir, "llm-gateway-state.json"), "utf8")) as { version: number; authRetired: boolean; cursorCommands: Array<{ path: string; target: string }> };
    assert.equal(state.version, 7);
    assert.equal(state.authRetired, false);
    assert.deepEqual(state.cursorCommands.map((command) => command.target), originalCursorTargets);
    assert.deepEqual(state.cursorCommands.map((command) => command.path), cursorCommands);
    assert.equal(lstatSync(agentCommand).isSymbolicLink(), true);
    assert.equal(statSync(join(home, ".local/libexec/dotfiles/cursor-acp-api-key-auth")).mode & 0o777, 0o700);
    assert.equal(statSync(join(home, ".local/libexec/dotfiles/cursor-agent-api")).mode & 0o777, 0o700);
    assert.equal(statSync(launcherCommand).mode & 0o777, 0o700);
    assert.equal(lstatSync(launcherCommand).isSymbolicLink(), false);
    assert.equal(resolveOnPath("cursor-agent", env.PATH), launcherCommand);
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
      launcherCommand,
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

    mkdirSync(decoyDir, { recursive: true });
    writeFileSync(join(decoyDir, "cursor-agent"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
    const shadowedCheck = spawnSync(script, ["--check"], {
      encoding: "utf8",
      env: { ...env, PATH: [decoyDir, env.PATH].join(":") },
    });
    assert.notEqual(shadowedCheck.status, 0);
    assert.match(shadowedCheck.stderr, /is not the managed API-key launcher/);

    const updatedCursorBin = join(home, ".local/share/cursor-agent/versions/updated/cursor-agent");
    mkdirSync(dirname(updatedCursorBin), { recursive: true });
    writeFileSync(updatedCursorBin, `#!/usr/bin/env bash
case "\${1:-}" in
  models) exit 0 ;;
  logout) rm -f "$HOME/.cursor/auth.json" ;;
  --version) printf '2026.08.25-3e8eec8\\n' ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
    for (const command of cursorCommands) {
      rmSync(command, { force: true });
      symlinkSync(updatedCursorBin, command);
    }
    // The self-updater has just replaced ~/.local/bin/cursor-agent with a vendor
    // symlink. Callers that resolve the name from PATH must still reach the
    // launcher during the window before the next convergence repairs it.
    const homeLocalBin = join(home, ".local/bin");
    const shimmedPath = [launcherDir, homeLocalBin, fixturePath(bin)].join(":");
    const shimmed = resolveOnPath("cursor-agent", shimmedPath);
    assert.equal(shimmed, launcherCommand);
    assert.ok(shimmed);
    const shimmedStatus = spawnSync(shimmed, ["status"], { encoding: "utf8", env });
    assert.equal(shimmedStatus.status, 0, shimmedStatus.stderr);
    assert.equal(shimmedStatus.stdout.trim(), "API key authenticated");

    const unshimmedPath = [homeLocalBin, fixturePath(bin)].join(":");
    const unshimmed = resolveOnPath("cursor-agent", unshimmedPath);
    assert.equal(unshimmed, join(homeLocalBin, "cursor-agent"));
    assert.ok(unshimmed);
    const unshimmedStatus = spawnSync(unshimmed, ["status"], { encoding: "utf8", env });
    assert.notEqual(unshimmedStatus.status, 0);
    assert.notEqual(unshimmedStatus.stdout.trim(), "API key authenticated");

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
    assert.deepEqual(JSON.parse(readFileSync(gatewayConfig, "utf8")), { ...validConfig, cursorAgentBin: updatedCursorBin });
    const versionAfterRepair = spawnSync(join(home, ".local/libexec/dotfiles/cursor-agent-api"), ["--version"], { encoding: "utf8", env });
    assert.equal(versionAfterRepair.status, 0, versionAfterRepair.stderr);
    assert.equal(versionAfterRepair.stdout.trim(), "2026.08.25-3e8eec8");

    // A host enrolled under version 6 converges. The `agent` copy it installed is
    // unreachable behind Homebrew's Grok cask, so convergence removes it and the
    // state stops claiming the name.
    const statePath = join(configDir, "llm-gateway-state.json");
    const downgradeToV6 = () => {
      const current = JSON.parse(readFileSync(statePath, "utf8")) as { cursorCommands: Array<{ path: string; target: string }> };
      writeFileSync(statePath, `${JSON.stringify({
        ...current,
        version: 6,
        cursorCommands: [...current.cursorCommands, { path: agentCommand, target: originalCursorTargets[0] }],
      }, null, 2)}\n`, { mode: 0o600 });
    };

    downgradeToV6();
    rmSync(agentCommand, { force: true });
    copyFileSync(join(home, ".local/libexec/dotfiles/cursor-agent-api"), agentCommand);
    chmodSync(agentCommand, 0o700);
    const migrate = run();
    assert.equal(migrate.status, 0, migrate.stderr);
    const migrated = JSON.parse(readFileSync(statePath, "utf8")) as { version: number; cursorCommands: Array<{ path: string }> };
    assert.equal(migrated.version, 7);
    assert.deepEqual(migrated.cursorCommands.map((command) => command.path), cursorCommands);
    assert.equal(existsSync(agentCommand), false);
    assert.equal(run("--check").status, 0);

    // The same migration on a host whose installer has already restored its own
    // symlink leaves that vendor file alone.
    downgradeToV6();
    symlinkSync(originalCursorTargets[0], agentCommand);
    const migrateVendor = run();
    assert.equal(migrateVendor.status, 0, migrateVendor.stderr);
    assert.equal((JSON.parse(readFileSync(statePath, "utf8")) as { version: number }).version, 7);
    assert.equal(lstatSync(agentCommand).isSymbolicLink(), true);
    assert.equal(readlinkSync(agentCommand), originalCursorTargets[0]);

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
    assert.equal(existsSync(launcherCommand), false);
    assert.equal(existsSync(join(home, ".local/libexec/dotfiles/cursor-acp-api-key-auth")), false);
    assert.equal(existsSync(join(home, ".local/libexec/dotfiles/llm-gateway-credential")), false);
    for (const [index, command] of cursorCommands.entries()) {
      assert.equal(lstatSync(command).isSymbolicLink(), true);
      assert.equal(readlinkSync(command), originalCursorTargets[index]);
    }
    assert.equal(lstatSync(agentCommand).isSymbolicLink(), true);
    assert.equal(readlinkSync(agentCommand), "../share/cursor-agent/versions/test/cursor-agent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
