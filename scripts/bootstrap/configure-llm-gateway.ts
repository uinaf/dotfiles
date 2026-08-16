#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type ConfigEdit, writeConfigEdits } from "./configure-codex.ts";

type GatewayConfig = {
  version: 1;
  secretFile: string;
  gatewayBaseUrl: string;
  cursorAgentBin: string;
};

type ClientStateV1 = {
  version: 1;
  codexConfigExisted: boolean;
  codexBackupPath: string | null;
};

type CursorCommandState = {
  path: string;
  target: string;
};

type ClientStateV2 = {
  version: 2;
  codexConfigExisted: boolean;
  codexBackupPath: string | null;
  cursorCommands: CursorCommandState[];
};

type ClientStateV3 = {
  version: 3;
  codexConfigExisted: boolean;
  codexBackupPath: string | null;
  cursorCommands: CursorCommandState[];
  claudeSettingsExisted: boolean;
  claudeBackupPath: string | null;
};

type ClientStateV4 = {
  version: 4;
  codexConfigExisted: boolean;
  codexBackupPath: string | null;
  cursorCommands: CursorCommandState[];
  claudeSettingsExisted: boolean;
  claudeBackupPath: string | null;
  authRetired: boolean;
};

type ClientState = ClientStateV1 | ClientStateV2 | ClientStateV3 | ClientStateV4;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceCredential = join(repoRoot, "scripts/agents/llm-gateway-credential.sh");
const sourceCursor = join(repoRoot, "scripts/agents/cursor-agent-api.sh");
const sourceCursorAcpAuth = join(repoRoot, "scripts/agents/cursor-acp-api-key-auth.py");

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownerOnly(path: string): boolean {
  return (statSync(path).mode & 0o077) === 0;
}

export function parseGatewayConfig(contents: string): GatewayConfig {
  const value: unknown = JSON.parse(contents);
  if (!isRecord(value) || !exactKeys(value, ["version", "secretFile", "gatewayBaseUrl", "cursorAgentBin"])) {
    throw new Error("gateway config must contain exactly version, secretFile, gatewayBaseUrl, and cursorAgentBin");
  }
  if (value.version !== 1) throw new Error("gateway config version must be 1");
  for (const field of ["secretFile", "gatewayBaseUrl", "cursorAgentBin"] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) throw new Error(`${field} must be a non-empty string`);
  }
  if (!isAbsolute(value.secretFile) || !isAbsolute(value.cursorAgentBin)) {
    throw new Error("secretFile and cursorAgentBin must be absolute paths");
  }
  const url = new URL(value.gatewayBaseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/v1")) {
    throw new Error("gatewayBaseUrl must be an HTTPS /v1 URL without credentials, query, or fragment");
  }
  return value as GatewayConfig;
}

export function gatewayEdits(config: GatewayConfig, credentialPath: string): ConfigEdit[] {
  return [
    { keyPath: "model", value: "gpt-5.6-sol", mergeStrategy: "upsert" },
    { keyPath: "model_provider", value: "llm_gateway", mergeStrategy: "upsert" },
    { keyPath: "model_providers.llm_gateway.name", value: "Private OpenAI-compatible gateway", mergeStrategy: "upsert" },
    { keyPath: "model_providers.llm_gateway.base_url", value: config.gatewayBaseUrl, mergeStrategy: "upsert" },
    { keyPath: "model_providers.llm_gateway.wire_api", value: "responses", mergeStrategy: "upsert" },
    { keyPath: "model_providers.llm_gateway.requires_openai_auth", value: false, mergeStrategy: "upsert" },
    { keyPath: "model_providers.llm_gateway.supports_websockets", value: false, mergeStrategy: "upsert" },
    { keyPath: "model_providers.llm_gateway.auth.command", value: credentialPath, mergeStrategy: "upsert" },
    { keyPath: "model_providers.llm_gateway.auth.args", value: ["gateway"], mergeStrategy: "upsert" },
    { keyPath: "model_providers.llm_gateway.auth.timeout_ms", value: 5000, mergeStrategy: "upsert" },
    { keyPath: "model_providers.llm_gateway.auth.refresh_interval_ms", value: 0, mergeStrategy: "upsert" },
  ];
}

export function claudeGatewayBaseUrl(gatewayBaseUrl: string): string {
  const url = new URL(gatewayBaseUrl);
  url.pathname = url.pathname.slice(0, -3) || "/";
  return url.toString().replace(/\/$/, "");
}

export function claudeGatewaySettings(contents: string, gatewayBaseUrl: string, credentialPath: string): Record<string, unknown> {
  const value: unknown = contents.trim() === "" ? {} : JSON.parse(contents);
  if (!isRecord(value)) throw new Error("Claude settings must contain a JSON object");
  const currentEnv = value.env === undefined ? {} : value.env;
  if (!isRecord(currentEnv)) throw new Error("Claude settings env must contain a JSON object");
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]) {
    if (key in currentEnv) throw new Error(`Claude settings env conflicts with the gateway: ${key}`);
  }
  return {
    ...value,
    apiKeyHelper: `${credentialPath} gateway`,
    env: { ...currentEnv, ANTHROPIC_BASE_URL: claudeGatewayBaseUrl(gatewayBaseUrl) },
  };
}

function atomicCopy(source: string, target: string, mode: number): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp.${process.pid}`;
  copyFileSync(source, temporary);
  chmodSync(temporary, mode);
  renameSync(temporary, target);
}

function atomicWriteJson(target: string, value: unknown): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

function readState(path: string): ClientState {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value)) {
    throw new Error("LLM gateway state has an invalid shape");
  }
  const v1 = value.version === 1 && exactKeys(value, ["version", "codexConfigExisted", "codexBackupPath"]);
  const v2 = value.version === 2 && exactKeys(value, ["version", "codexConfigExisted", "codexBackupPath", "cursorCommands"]);
  const v3 = value.version === 3 && exactKeys(value, [
    "version",
    "codexConfigExisted",
    "codexBackupPath",
    "cursorCommands",
    "claudeSettingsExisted",
    "claudeBackupPath",
  ]);
  const v4 = value.version === 4 && exactKeys(value, [
    "version",
    "codexConfigExisted",
    "codexBackupPath",
    "cursorCommands",
    "claudeSettingsExisted",
    "claudeBackupPath",
    "authRetired",
  ]);
  if (!v1 && !v2 && !v3 && !v4) throw new Error("LLM gateway state has an invalid shape");
  if (typeof value.codexConfigExisted !== "boolean" || !(value.codexBackupPath === null || typeof value.codexBackupPath === "string")) {
    throw new Error("LLM gateway state has invalid values");
  }
  if (v2 || v3 || v4) {
    if (!Array.isArray(value.cursorCommands) || value.cursorCommands.length !== 2) {
      throw new Error("LLM gateway state has invalid Cursor commands");
    }
    for (const command of value.cursorCommands) {
      if (!isRecord(command) || !exactKeys(command, ["path", "target"]) || typeof command.path !== "string" || typeof command.target !== "string") {
        throw new Error("LLM gateway state has invalid Cursor commands");
      }
    }
  }
  if ((v3 || v4) && (typeof value.claudeSettingsExisted !== "boolean" || !(value.claudeBackupPath === null || typeof value.claudeBackupPath === "string"))) {
    throw new Error("LLM gateway state has invalid Claude settings values");
  }
  if (v4 && typeof value.authRetired !== "boolean") throw new Error("LLM gateway state has an invalid auth retirement value");
  return value as ClientState;
}

function captureCursorCommands(paths: readonly string[]): CursorCommandState[] {
  return paths.map((path) => {
    if (!existsSync(path) || !lstatSync(path).isSymbolicLink()) {
      throw new Error(`Cursor command must be an installer-managed symlink before enrollment: ${path}`);
    }
    return { path, target: readlinkSync(path) };
  });
}

function restoreCursorCommands(commands: readonly CursorCommandState[]): void {
  for (const command of commands) {
    rmSync(command.path, { force: true });
    mkdirSync(dirname(command.path), { recursive: true, mode: 0o700 });
    symlinkSync(command.target, command.path);
  }
}

function assertStateCursorCommands(state: ClientStateV2 | ClientStateV3 | ClientStateV4, expectedPaths: readonly string[]): void {
  if (!state.cursorCommands.every((command, index) => command.path === expectedPaths[index])) {
    throw new Error("LLM gateway state contains unexpected Cursor command paths");
  }
}

function runLogout(command: string, args: readonly string[], env: NodeJS.ProcessEnv, label: string): void {
  const result = spawnSync(command, args, { encoding: "utf8", env });
  if (result.status !== 0) throw new Error(`${label} logout failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 1}`}`);
}

function withoutEnvironmentKey(env: NodeJS.ProcessEnv, key: string): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name !== key));
}

export function assertCursorAgentBinSafe(cursorAgentBin: string, managedPaths: readonly string[]): void {
  if (managedPaths.includes(resolve(cursorAgentBin))) {
    throw new Error("cursorAgentBin must point to Cursor's versioned vendor executable, not a managed launcher path");
  }
}

function validateLocalInputs(configPath: string): GatewayConfig {
  if (!existsSync(configPath) || lstatSync(configPath).isSymbolicLink() || !lstatSync(configPath).isFile()) {
    throw new Error(`gateway config must be a regular file: ${configPath}`);
  }
  if (!ownerOnly(configPath)) throw new Error("gateway config must not be accessible by group or other users");
  const config = parseGatewayConfig(readFileSync(configPath, "utf8"));
  if (!existsSync(config.secretFile) || lstatSync(config.secretFile).isSymbolicLink() || !lstatSync(config.secretFile).isFile()) {
    throw new Error("secretFile must be a regular SOPS payload");
  }
  if (!existsSync(config.cursorAgentBin) || (statSync(config.cursorAgentBin).mode & 0o111) === 0) {
    throw new Error("cursorAgentBin must be executable");
  }
  const status = spawnSync("sops", ["filestatus", config.secretFile], { encoding: "utf8" });
  if (status.status !== 0 || !/"encrypted"\s*:\s*true/.test(status.stdout)) {
    throw new Error("secretFile is not encrypted SOPS data");
  }
  return config;
}

function assertInstalledFile(source: string, target: string): void {
  if (!existsSync(target) || readFileSync(source, "utf8") !== readFileSync(target, "utf8")) {
    throw new Error(`installed helper drifted: ${target}`);
  }
  if ((statSync(target).mode & 0o777) !== 0o700) throw new Error(`installed helper mode drifted: ${target}`);
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args.length === 0 ? "apply" : args.length === 1 && ["--check", "--retire-auth", "--rollback"].includes(args[0]) ? args[0].slice(2) : "invalid";
  if (mode === "invalid") throw new Error("usage: configure-llm-gateway.ts [--check|--retire-auth|--rollback]");

  const home = resolve(process.env.HOME || "");
  const codexHome = resolve(process.env.CODEX_HOME || join(home, ".codex"));
  const codexConfig = resolve(process.env.CODEX_CONFIG_PATH || join(codexHome, "config.toml"));
  const claudeSettings = resolve(process.env.CLAUDE_SETTINGS_PATH || join(home, ".claude/settings.json"));
  const configPath = resolve(process.env.LLM_GATEWAY_CONFIG || join(home, ".config/dotfiles/llm-gateway.json"));
  const statePath = join(home, ".config/dotfiles/llm-gateway-state.json");
  const legacyStatePath = join(home, ".config/dotfiles/llm-client-state.json");
  const credentialTarget = join(home, ".local/libexec/dotfiles/llm-gateway-credential");
  const cursorAcpAuthTarget = join(home, ".local/libexec/dotfiles/cursor-acp-api-key-auth");
  const legacyCredentialTarget = join(home, ".local/libexec/dotfiles/llm-client-credential");
  const cursorApiTarget = join(home, ".local/bin/cursor-agent-api");
  const cursorCommandTargets = [join(home, ".local/bin/cursor-agent"), join(home, ".local/bin/agent")];
  const managedCursorTargets = [cursorApiTarget, ...cursorCommandTargets];
  const codexBackupPath = `${codexConfig}.llm-gateway.backup`;
  const claudeBackupPath = `${claudeSettings}.llm-gateway.backup`;

  if (mode === "rollback") {
    const rollbackStatePath = existsSync(statePath) ? statePath : legacyStatePath;
    if (!existsSync(rollbackStatePath)) {
      process.stdout.write("LLM gateway is already rolled back\n");
      return;
    }
    const state = readState(rollbackStatePath);
    if (state.version >= 2) assertStateCursorCommands(state, cursorCommandTargets);
    if (state.codexConfigExisted) {
      if (!state.codexBackupPath || !existsSync(state.codexBackupPath)) throw new Error("Codex rollback backup is missing");
      atomicCopy(state.codexBackupPath, codexConfig, 0o600);
    } else {
      rmSync(codexConfig, { force: true });
    }
    if (state.version >= 3) {
      if (state.claudeSettingsExisted) {
        if (!state.claudeBackupPath || !existsSync(state.claudeBackupPath)) throw new Error("Claude rollback backup is missing");
        atomicCopy(state.claudeBackupPath, claudeSettings, 0o600);
      } else {
        rmSync(claudeSettings, { force: true });
      }
    }
    rmSync(credentialTarget, { force: true });
    rmSync(cursorAcpAuthTarget, { force: true });
    rmSync(legacyCredentialTarget, { force: true });
    rmSync(cursorApiTarget, { force: true });
    if (state.version >= 2) restoreCursorCommands(state.cursorCommands);
    if (state.codexBackupPath) rmSync(state.codexBackupPath, { force: true });
    if (state.version >= 3 && state.claudeBackupPath) rmSync(state.claudeBackupPath, { force: true });
    rmSync(rollbackStatePath, { force: true });
    process.stdout.write(state.version === 4 && state.authRetired
      ? "rolled back LLM gateway; coding login state was retired and requires reauthentication\n"
      : "rolled back LLM gateway; saved Codex and Claude login state remains untouched\n");
    return;
  }

  const config = validateLocalInputs(configPath);
  assertCursorAgentBinSafe(config.cursorAgentBin, managedCursorTargets);
  const desiredClaudeSettings = claudeGatewaySettings(
    existsSync(claudeSettings) ? readFileSync(claudeSettings, "utf8") : "",
    config.gatewayBaseUrl,
    credentialTarget,
  );
  if (mode === "check" || mode === "retire-auth") {
    if (!existsSync(statePath) || !ownerOnly(statePath)) throw new Error("LLM gateway state is missing or not owner-only");
    const state = readState(statePath);
    if (state.version !== 4) throw new Error("LLM gateway state must be upgraded by applying the configurator");
    assertStateCursorCommands(state, cursorCommandTargets);
    assertInstalledFile(sourceCredential, credentialTarget);
    assertInstalledFile(sourceCursorAcpAuth, cursorAcpAuthTarget);
    for (const target of managedCursorTargets) assertInstalledFile(sourceCursor, target);
    const contents = readFileSync(codexConfig, "utf8");
    for (const expected of [
      'model_provider = "llm_gateway"',
      config.gatewayBaseUrl,
      credentialTarget,
      '[model_providers.llm_gateway.auth]',
      'args = ["gateway"]',
    ]) {
      if (!contents.includes(expected)) throw new Error("Codex gateway config drifted");
    }
    const claude = JSON.parse(readFileSync(claudeSettings, "utf8")) as { apiKeyHelper?: unknown; env?: Record<string, unknown> };
    if (claude.apiKeyHelper !== `${credentialTarget} gateway` || claude.env?.ANTHROPIC_BASE_URL !== claudeGatewayBaseUrl(config.gatewayBaseUrl)) {
      throw new Error("Claude gateway settings drifted");
    }
    for (const kind of ["cursor", "gateway"]) {
      const result = spawnSync(credentialTarget, [kind], { encoding: "utf8", env: { ...process.env, LLM_GATEWAY_CONFIG: configPath } });
      if (result.status !== 0 || result.stdout.trim().length === 0) throw new Error(`${kind} credential helper failed`);
    }
    if (mode === "check") {
      process.stdout.write(`ok LLM gateway config, helpers, ciphertext, Codex provider, Claude settings, and auth-retired=${state.authRetired}\n`);
      return;
    }

    runLogout(process.env.CODEX_BIN || "codex", ["logout"], { ...process.env, CODEX_HOME: codexHome }, "Codex");
    runLogout("claude", ["auth", "logout"], process.env, "Claude");
    runLogout(
      config.cursorAgentBin,
      ["logout"],
      { ...withoutEnvironmentKey(process.env, "CURSOR_API_KEY"), AGENT_CLI_CREDENTIAL_STORE: "file" },
      "Cursor",
    );
    await writeConfigEdits([{ keyPath: "forced_login_method", value: null, mergeStrategy: "replace" }]);
    atomicWriteJson(statePath, { ...state, authRetired: true } satisfies ClientStateV4);
    process.stdout.write("retired saved Codex, Claude, and Cursor coding logins; gateway routing remains configured\n");
    return;
  }

  if (!existsSync(statePath) && existsSync(legacyStatePath)) renameSync(legacyStatePath, statePath);

  if (!existsSync(statePath)) {
    const cursorCommands = captureCursorCommands(cursorCommandTargets);
    const codexExisted = existsSync(codexConfig);
    const claudeExisted = existsSync(claudeSettings);
    if (codexExisted && existsSync(codexBackupPath)) throw new Error(`refusing to overwrite existing backup: ${codexBackupPath}`);
    if (claudeExisted && existsSync(claudeBackupPath)) throw new Error(`refusing to overwrite existing backup: ${claudeBackupPath}`);
    if (codexExisted) atomicCopy(codexConfig, codexBackupPath, 0o600);
    if (claudeExisted) atomicCopy(claudeSettings, claudeBackupPath, 0o600);
    atomicWriteJson(statePath, {
      version: 4,
      codexConfigExisted: codexExisted,
      codexBackupPath: codexExisted ? codexBackupPath : null,
      cursorCommands,
      claudeSettingsExisted: claudeExisted,
      claudeBackupPath: claudeExisted ? claudeBackupPath : null,
      authRetired: false,
    } satisfies ClientStateV4);
  } else {
    const state = readState(statePath);
    const cursorCommands = state.version === 1 ? captureCursorCommands(cursorCommandTargets) : state.cursorCommands;
    if (state.version >= 2) assertStateCursorCommands(state, cursorCommandTargets);
    if (state.version < 3) {
      const claudeExisted = existsSync(claudeSettings);
      if (claudeExisted && existsSync(claudeBackupPath)) throw new Error(`refusing to overwrite existing backup: ${claudeBackupPath}`);
      if (claudeExisted) atomicCopy(claudeSettings, claudeBackupPath, 0o600);
      atomicWriteJson(statePath, {
        version: 4,
        codexConfigExisted: state.codexConfigExisted,
        codexBackupPath: state.codexBackupPath,
        cursorCommands,
        claudeSettingsExisted: claudeExisted,
        claudeBackupPath: claudeExisted ? claudeBackupPath : null,
        authRetired: false,
      } satisfies ClientStateV4);
    } else if (state.version === 3) {
      atomicWriteJson(statePath, {
        ...state,
        version: 4,
        authRetired: false,
      } satisfies ClientStateV4);
    }
  }

  atomicCopy(sourceCredential, credentialTarget, 0o700);
  atomicCopy(sourceCursorAcpAuth, cursorAcpAuthTarget, 0o700);
  for (const target of managedCursorTargets) atomicCopy(sourceCursor, target, 0o700);
  await writeConfigEdits(gatewayEdits(config, credentialTarget));
  chmodSync(codexConfig, 0o600);
  atomicWriteJson(claudeSettings, desiredClaudeSettings);
  rmSync(legacyCredentialTarget, { force: true });
  process.stdout.write("configured Codex and Claude gateway routing plus canonical Cursor API-key commands; saved logins remain untouched\n");
}

if (import.meta.main) {
  try {
    await run();
  } catch (error) {
    process.stderr.write(`FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
