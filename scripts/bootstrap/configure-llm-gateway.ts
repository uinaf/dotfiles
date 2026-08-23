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
  version: 2;
  credentials: {
    gateway: string;
    cursor?: string;
    opencode?: string;
  };
  gatewayBaseUrl: string;
  cursorAgentBin?: string;
  grokBin?: string;
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

type ClientStateV5 = {
  version: 5;
  codexConfigExisted: boolean;
  codexBackupPath: string | null;
  cursorCommands: CursorCommandState[];
  claudeSettingsExisted: boolean;
  claudeBackupPath: string | null;
  authRetired: boolean;
  grokEnabled: boolean;
};

type ClientStateV6 = {
  version: 6;
  codexConfigExisted: boolean;
  codexBackupPath: string | null;
  cursorCommands: CursorCommandState[];
  claudeSettingsExisted: boolean;
  claudeBackupPath: string | null;
  authRetired: boolean;
  grokEnabled: boolean;
  grokConfigExisted: boolean;
  grokConfigBackupPath: string | null;
  grokAuthExisted: boolean;
  grokAuthBackupPath: string | null;
};

type ClientState = ClientStateV1 | ClientStateV2 | ClientStateV3 | ClientStateV4 | ClientStateV5 | ClientStateV6;

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
  if (!isRecord(value)) throw new Error("gateway config must contain a JSON object");
  const allowed = new Set(["version", "credentials", "gatewayBaseUrl", "cursorAgentBin", "grokBin"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("gateway config contains an unknown field");
  }
  if (value.version !== 2) throw new Error("gateway config version must be 2");
  if (typeof value.gatewayBaseUrl !== "string" || value.gatewayBaseUrl.length === 0) {
    throw new Error("gatewayBaseUrl must be a non-empty string");
  }
  if (!isRecord(value.credentials)) throw new Error("credentials must contain an object of resolved strings");
  const credentialKeys = Object.keys(value.credentials);
  if (credentialKeys.some((key) => !["gateway", "cursor", "opencode"].includes(key))) {
    throw new Error("credentials contains an unknown field");
  }
  if (typeof value.credentials.gateway !== "string" || !/^[A-Za-z0-9_-]{32,}$/.test(value.credentials.gateway)) {
    throw new Error("credentials.gateway must be a resolved gateway key");
  }
  if (value.credentials.cursor !== undefined &&
    (typeof value.credentials.cursor !== "string" || !/^crsr_[A-Za-z0-9_-]{64}$/.test(value.credentials.cursor))) {
    throw new Error("credentials.cursor must be a resolved Cursor key when configured");
  }
  if (value.credentials.opencode !== undefined &&
    (typeof value.credentials.opencode !== "string" || !/^[A-Za-z0-9_-]{20,}$/.test(value.credentials.opencode))) {
    throw new Error("credentials.opencode must be a resolved OpenCode Zen key when configured");
  }
  for (const field of ["cursorAgentBin", "grokBin"] as const) {
    if (value[field] !== undefined && (typeof value[field] !== "string" || value[field].length === 0 || !isAbsolute(value[field]))) {
      throw new Error(`${field} must be an absolute path when configured`);
    }
  }
  if ((value.cursorAgentBin === undefined) !== (value.credentials.cursor === undefined)) {
    throw new Error("cursorAgentBin and credentials.cursor must be configured together");
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
    { keyPath: "features.apps", value: false, mergeStrategy: "upsert" },
    { keyPath: "mcp_servers.node_repl", value: null, mergeStrategy: "replace" },
    { keyPath: "mcp_servers.computer-use", value: null, mergeStrategy: "replace" },
    { keyPath: "notify", value: null, mergeStrategy: "replace" },
    { keyPath: "model_providers.llm_gateway.name", value: "zebroid-gateway", mergeStrategy: "upsert" },
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

function atomicWriteText(target: string, value: string, mode: number): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp.${process.pid}`;
  writeFileSync(temporary, value, { mode });
  renameSync(temporary, target);
}

function captureOptionalBackup(source: string, backup: string, label: string): { existed: boolean; backupPath: string | null } {
  const existed = existsSync(source);
  if (existed && existsSync(backup)) throw new Error(`refusing to overwrite existing ${label} backup: ${backup}`);
  if (existed) atomicCopy(source, backup, 0o600);
  return { existed, backupPath: existed ? backup : null };
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
  const v5 = value.version === 5 && exactKeys(value, [
    "version",
    "codexConfigExisted",
    "codexBackupPath",
    "cursorCommands",
    "claudeSettingsExisted",
    "claudeBackupPath",
    "authRetired",
    "grokEnabled",
  ]);
  const v6 = value.version === 6 && exactKeys(value, [
    "version",
    "codexConfigExisted",
    "codexBackupPath",
    "cursorCommands",
    "claudeSettingsExisted",
    "claudeBackupPath",
    "authRetired",
    "grokEnabled",
    "grokConfigExisted",
    "grokConfigBackupPath",
    "grokAuthExisted",
    "grokAuthBackupPath",
  ]);
  if (!v1 && !v2 && !v3 && !v4 && !v5 && !v6) throw new Error("LLM gateway state has an invalid shape");
  if (typeof value.codexConfigExisted !== "boolean" || !(value.codexBackupPath === null || typeof value.codexBackupPath === "string")) {
    throw new Error("LLM gateway state has invalid values");
  }
  if (v2 || v3 || v4 || v5 || v6) {
    if (!Array.isArray(value.cursorCommands) || ![0, 2].includes(value.cursorCommands.length)) {
      throw new Error("LLM gateway state has invalid Cursor commands");
    }
    for (const command of value.cursorCommands) {
      if (!isRecord(command) || !exactKeys(command, ["path", "target"]) || typeof command.path !== "string" || typeof command.target !== "string") {
        throw new Error("LLM gateway state has invalid Cursor commands");
      }
    }
  }
  if ((v3 || v4 || v5 || v6) && (typeof value.claudeSettingsExisted !== "boolean" || !(value.claudeBackupPath === null || typeof value.claudeBackupPath === "string"))) {
    throw new Error("LLM gateway state has invalid Claude settings values");
  }
  if ((v4 || v5 || v6) && typeof value.authRetired !== "boolean") throw new Error("LLM gateway state has an invalid auth retirement value");
  if ((v5 || v6) && typeof value.grokEnabled !== "boolean") throw new Error("LLM gateway state has an invalid Grok value");
  if (v6) {
    if (typeof value.grokConfigExisted !== "boolean" || !(value.grokConfigBackupPath === null || typeof value.grokConfigBackupPath === "string")) {
      throw new Error("LLM gateway state has invalid Grok config values");
    }
    if (typeof value.grokAuthExisted !== "boolean" || !(value.grokAuthBackupPath === null || typeof value.grokAuthBackupPath === "string")) {
      throw new Error("LLM gateway state has invalid Grok auth values");
    }
  }
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

function assertStateCursorCommands(state: ClientStateV2 | ClientStateV3 | ClientStateV4 | ClientStateV5 | ClientStateV6, expectedPaths: readonly string[], enabled = true): void {
  const expected = enabled ? expectedPaths : [];
  if (state.cursorCommands.length !== expected.length || !state.cursorCommands.every((command, index) => command.path === expected[index])) {
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

const grokGatewayBegin = "# BEGIN dotfiles LLM gateway";
const grokGatewayEnd = "# END dotfiles LLM gateway";

function grokGatewayBlock(gatewayBaseUrl: string, credentialPath: string): string {
  return [
    grokGatewayBegin,
    "[models]",
    'default = "grok-4.6"',
    "",
    "[endpoints]",
    `models_base_url = ${JSON.stringify(gatewayBaseUrl)}`,
    "",
    "[auth]",
    `auth_provider_command = ${JSON.stringify(`${credentialPath} gateway`)}`,
    'auth_provider_label = "zebroid-gateway"',
    "auth_token_ttl = 3600",
    "",
    '[model."grok-4.6"]',
    'api_backend = "responses"',
    grokGatewayEnd,
  ].join("\n");
}

export function grokGatewaySettings(contents: string, gatewayBaseUrl: string, credentialPath: string): string {
  const managed = new RegExp(`${grokGatewayBegin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${grokGatewayEnd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`, "g");
  const original = contents.replace(managed, "").trimEnd();
  for (const section of ["models", "endpoints", "auth", 'model."grok-4.6"']) {
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`^\\s*\\[${escaped}\\]\\s*$`, "m").test(original)) {
      throw new Error(`Grok config conflicts with gateway section: ${section}`);
    }
  }
  return `${original}${original ? "\n\n" : ""}${grokGatewayBlock(gatewayBaseUrl, credentialPath)}\n`;
}

function validateLocalInputs(configPath: string): GatewayConfig {
  if (!existsSync(configPath) || lstatSync(configPath).isSymbolicLink() || !lstatSync(configPath).isFile()) {
    throw new Error(`gateway config must be a regular file: ${configPath}`);
  }
  if (!ownerOnly(configPath)) throw new Error("gateway config must not be accessible by group or other users");
  const config = parseGatewayConfig(readFileSync(configPath, "utf8"));
  if (config.cursorAgentBin && (!existsSync(config.cursorAgentBin) || (statSync(config.cursorAgentBin).mode & 0o111) === 0)) {
    throw new Error("cursorAgentBin must be executable");
  }
  if (config.grokBin && (!existsSync(config.grokBin) || (statSync(config.grokBin).mode & 0o111) === 0)) {
    throw new Error("grokBin must be executable");
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
  const codexAuth = join(codexHome, "auth.json");
  const claudeSettings = resolve(process.env.CLAUDE_SETTINGS_PATH || join(home, ".claude/settings.json"));
  const claudeAuth = join(home, ".claude/.credentials.json");
  const configPath = resolve(process.env.LLM_GATEWAY_CONFIG || join(home, ".config/dotfiles/llm-gateway.json"));
  const statePath = join(home, ".config/dotfiles/llm-gateway-state.json");
  const legacyStatePath = join(home, ".config/dotfiles/llm-client-state.json");
  const credentialTarget = join(home, ".local/libexec/dotfiles/llm-gateway-credential");
  const cursorAcpAuthTarget = join(home, ".local/libexec/dotfiles/cursor-acp-api-key-auth");
  const legacyCredentialTarget = join(home, ".local/libexec/dotfiles/llm-client-credential");
  const cursorApiTarget = join(home, ".local/bin/cursor-agent-api");
  const cursorCommandTargets = [join(home, ".local/bin/cursor-agent"), join(home, ".local/bin/agent")];
  const cursorAuth = join(home, ".cursor/auth.json");
  const managedCursorTargets = [cursorApiTarget, ...cursorCommandTargets];
  const grokHome = join(home, ".grok");
  const grokConfig = join(grokHome, "config.toml");
  const grokAuth = join(grokHome, "auth.json");
  const legacyGrokTarget = join(home, ".local/bin/grok-gateway");
  const legacyGrokHome = join(home, ".config/dotfiles/grok-gateway");
  const codexBackupPath = `${codexConfig}.llm-gateway.backup`;
  const claudeBackupPath = `${claudeSettings}.llm-gateway.backup`;
  const grokConfigBackupPath = `${grokConfig}.llm-gateway.backup`;
  const grokAuthBackupPath = `${grokAuth}.llm-gateway.backup`;

  if (mode === "rollback") {
    const rollbackStatePath = existsSync(statePath) ? statePath : legacyStatePath;
    if (!existsSync(rollbackStatePath)) {
      process.stdout.write("LLM gateway is already rolled back\n");
      return;
    }
    const state = readState(rollbackStatePath);
    if (state.version >= 2) assertStateCursorCommands(state, cursorCommandTargets, state.cursorCommands.length > 0);
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
    if (state.version >= 2 && state.cursorCommands.length > 0) restoreCursorCommands(state.cursorCommands);
    if (state.version === 5 && state.grokEnabled) {
      rmSync(legacyGrokTarget, { force: true });
      rmSync(legacyGrokHome, { recursive: true, force: true });
    }
    if (state.version === 6 && state.grokEnabled) {
      if (state.grokConfigExisted) {
        if (!state.grokConfigBackupPath || !existsSync(state.grokConfigBackupPath)) throw new Error("Grok config rollback backup is missing");
        atomicCopy(state.grokConfigBackupPath, grokConfig, 0o600);
      } else {
        rmSync(grokConfig, { force: true });
      }
      if (state.grokAuthExisted) {
        if (!state.grokAuthBackupPath || !existsSync(state.grokAuthBackupPath)) throw new Error("Grok auth rollback backup is missing");
        atomicCopy(state.grokAuthBackupPath, grokAuth, 0o600);
      } else {
        rmSync(grokAuth, { force: true });
      }
    }
    if (state.codexBackupPath) rmSync(state.codexBackupPath, { force: true });
    if (state.version >= 3 && state.claudeBackupPath) rmSync(state.claudeBackupPath, { force: true });
    if (state.version === 6 && state.grokConfigBackupPath) rmSync(state.grokConfigBackupPath, { force: true });
    if (state.version === 6 && state.grokAuthBackupPath) rmSync(state.grokAuthBackupPath, { force: true });
    rmSync(rollbackStatePath, { force: true });
    process.stdout.write(state.version >= 4 && state.authRetired
      ? "rolled back LLM gateway; coding login state was retired and requires reauthentication\n"
      : "rolled back LLM gateway; saved Codex, Claude, and Grok login state remains available\n");
    return;
  }

  const config = validateLocalInputs(configPath);
  if (config.cursorAgentBin) assertCursorAgentBinSafe(config.cursorAgentBin, managedCursorTargets);
  const desiredClaudeSettings = claudeGatewaySettings(
    existsSync(claudeSettings) ? readFileSync(claudeSettings, "utf8") : "",
    config.gatewayBaseUrl,
    credentialTarget,
  );
  if (mode === "check" || mode === "retire-auth") {
    if (!existsSync(statePath) || !ownerOnly(statePath)) throw new Error("LLM gateway state is missing or not owner-only");
    const state = readState(statePath);
    if (state.version !== 6) throw new Error("LLM gateway state must be upgraded by applying the configurator");
    assertStateCursorCommands(state, cursorCommandTargets, Boolean(config.cursorAgentBin));
    assertInstalledFile(sourceCredential, credentialTarget);
    if (config.cursorAgentBin) {
      assertInstalledFile(sourceCursorAcpAuth, cursorAcpAuthTarget);
      for (const target of managedCursorTargets) assertInstalledFile(sourceCursor, target);
    }
    if (config.grokBin) {
      const originalGrokConfig = state.grokConfigExisted
        ? readFileSync(state.grokConfigBackupPath || "", "utf8")
        : "";
      if (!existsSync(grokConfig) || readFileSync(grokConfig, "utf8") !== grokGatewaySettings(originalGrokConfig, config.gatewayBaseUrl, credentialTarget)) {
        throw new Error("Grok gateway config drifted");
      }
      if (!existsSync(grokAuth) || !ownerOnly(grokAuth)) throw new Error("Grok gateway authentication is missing or not owner-only");
    }
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
    const credentialKinds = ["gateway"];
    if (config.cursorAgentBin) credentialKinds.push("cursor");
    if (config.credentials.opencode) credentialKinds.push("opencode");
    for (const kind of credentialKinds) {
      const result = spawnSync(credentialTarget, [kind], { encoding: "utf8", env: { ...process.env, LLM_GATEWAY_CONFIG: configPath } });
      if (result.status !== 0 || result.stdout.trim().length === 0) {
        const detail = result.stderr.trim() || `exit ${result.status ?? "unknown"} without output`;
        throw new Error(`${kind} credential helper failed: ${detail}`);
      }
    }
    if (mode === "check" && state.authRetired) {
      for (const [label, path] of [["Codex", codexAuth], ["Claude", claudeAuth], ["Cursor", cursorAuth]] as const) {
        if (existsSync(path)) throw new Error(`${label} saved login state remains after retirement`);
      }
      if (state.grokAuthBackupPath && existsSync(state.grokAuthBackupPath)) {
        throw new Error("Grok saved vendor login remains after retirement");
      }
    }
    if (mode === "check") {
      process.stdout.write(`ok LLM gateway config, helpers, resolved credentials, Codex provider, Claude settings, Cursor=${Boolean(config.cursorAgentBin)}, Grok=${Boolean(config.grokBin)}, OpenCode=${Boolean(config.credentials.opencode)}, and auth-retired=${state.authRetired}\n`);
      return;
    }

    const returnedAuth = state.authRetired && (
      existsSync(codexAuth) ||
      existsSync(claudeAuth) ||
      (Boolean(config.cursorAgentBin) && existsSync(cursorAuth)) ||
      Boolean(state.grokAuthBackupPath && existsSync(state.grokAuthBackupPath))
    );
    if (state.authRetired && !returnedAuth) {
      process.stdout.write("coding vendor login state is already retired; gateway routing remains configured\n");
      return;
    }

    if (!state.authRetired || existsSync(codexAuth)) {
      runLogout(process.env.CODEX_BIN || "codex", ["logout"], { ...process.env, CODEX_HOME: codexHome }, "Codex");
    }
    if (!state.authRetired || existsSync(claudeAuth)) {
      runLogout("claude", ["auth", "logout"], process.env, "Claude");
    }
    if (config.cursorAgentBin && (!state.authRetired || existsSync(cursorAuth))) {
      runLogout(
        config.cursorAgentBin,
        ["logout"],
        { ...withoutEnvironmentKey(process.env, "CURSOR_API_KEY"), AGENT_CLI_CREDENTIAL_STORE: "file" },
        "Cursor",
      );
    }
    await writeConfigEdits([{ keyPath: "forced_login_method", value: null, mergeStrategy: "replace" }]);
    if (state.grokAuthBackupPath) rmSync(state.grokAuthBackupPath, { force: true });
    atomicWriteJson(statePath, {
      ...state,
      authRetired: true,
      grokAuthExisted: false,
      grokAuthBackupPath: null,
    } satisfies ClientStateV6);
    process.stdout.write(state.authRetired
      ? "retired returned coding vendor login state; gateway routing remains configured\n"
      : `retired saved Codex, Claude${config.cursorAgentBin ? ", Cursor" : ""}, and Grok vendor logins; gateway routing remains configured\n`);
    return;
  }

  if (!existsSync(statePath) && existsSync(legacyStatePath)) renameSync(legacyStatePath, statePath);

  let removeLegacyGrok = false;
  if (!existsSync(statePath)) {
    const cursorCommands = config.cursorAgentBin ? captureCursorCommands(cursorCommandTargets) : [];
    const codexExisted = existsSync(codexConfig);
    const claudeExisted = existsSync(claudeSettings);
    if (codexExisted && existsSync(codexBackupPath)) throw new Error(`refusing to overwrite existing backup: ${codexBackupPath}`);
    if (claudeExisted && existsSync(claudeBackupPath)) throw new Error(`refusing to overwrite existing backup: ${claudeBackupPath}`);
    if (codexExisted) atomicCopy(codexConfig, codexBackupPath, 0o600);
    if (claudeExisted) atomicCopy(claudeSettings, claudeBackupPath, 0o600);
    const grokConfigState = config.grokBin
      ? captureOptionalBackup(grokConfig, grokConfigBackupPath, "Grok config")
      : { existed: false, backupPath: null };
    const grokAuthState = config.grokBin
      ? captureOptionalBackup(grokAuth, grokAuthBackupPath, "Grok auth")
      : { existed: false, backupPath: null };
    atomicWriteJson(statePath, {
      version: 6,
      codexConfigExisted: codexExisted,
      codexBackupPath: codexExisted ? codexBackupPath : null,
      cursorCommands,
      claudeSettingsExisted: claudeExisted,
      claudeBackupPath: claudeExisted ? claudeBackupPath : null,
      authRetired: false,
      grokEnabled: Boolean(config.grokBin),
      grokConfigExisted: grokConfigState.existed,
      grokConfigBackupPath: grokConfigState.backupPath,
      grokAuthExisted: grokAuthState.existed,
      grokAuthBackupPath: grokAuthState.backupPath,
    } satisfies ClientStateV6);
  } else {
    const state = readState(statePath);
    const cursorCommands = state.version === 1 ? (config.cursorAgentBin ? captureCursorCommands(cursorCommandTargets) : []) : state.cursorCommands;
    if (state.version >= 2) assertStateCursorCommands(state, cursorCommandTargets, Boolean(config.cursorAgentBin));
    if (state.version >= 5 && state.grokEnabled !== Boolean(config.grokBin)) {
      throw new Error("Grok enrollment changed; roll back before changing the client set");
    }
    if (state.version < 6) {
      const claudeExisted = state.version >= 3 ? state.claudeSettingsExisted : existsSync(claudeSettings);
      const claudeBackup = state.version >= 3 ? state.claudeBackupPath : (claudeExisted ? claudeBackupPath : null);
      if (state.version < 3 && claudeExisted) {
        if (existsSync(claudeBackupPath)) throw new Error(`refusing to overwrite existing backup: ${claudeBackupPath}`);
        atomicCopy(claudeSettings, claudeBackupPath, 0o600);
      }
      const grokConfigState = config.grokBin
        ? captureOptionalBackup(grokConfig, grokConfigBackupPath, "Grok config")
        : { existed: false, backupPath: null };
      const grokAuthState = config.grokBin
        ? captureOptionalBackup(grokAuth, grokAuthBackupPath, "Grok auth")
        : { existed: false, backupPath: null };
      removeLegacyGrok = state.version === 5 && state.grokEnabled;
      atomicWriteJson(statePath, {
        version: 6,
        codexConfigExisted: state.codexConfigExisted,
        codexBackupPath: state.codexBackupPath,
        cursorCommands,
        claudeSettingsExisted: claudeExisted,
        claudeBackupPath: claudeBackup,
        authRetired: state.version >= 4 ? state.authRetired : false,
        grokEnabled: Boolean(config.grokBin),
        grokConfigExisted: grokConfigState.existed,
        grokConfigBackupPath: grokConfigState.backupPath,
        grokAuthExisted: grokAuthState.existed,
        grokAuthBackupPath: grokAuthState.backupPath,
      } satisfies ClientStateV6);
    }
  }

  atomicCopy(sourceCredential, credentialTarget, 0o700);
  if (config.cursorAgentBin) {
    atomicCopy(sourceCursorAcpAuth, cursorAcpAuthTarget, 0o700);
    for (const target of managedCursorTargets) atomicCopy(sourceCursor, target, 0o700);
  }
  if (config.grokBin) {
    const state = readState(statePath);
    if (state.version !== 6) throw new Error("LLM gateway state migration failed");
    const originalGrokConfig = state.grokConfigExisted
      ? readFileSync(state.grokConfigBackupPath || "", "utf8")
      : "";
    atomicWriteText(grokConfig, grokGatewaySettings(originalGrokConfig, config.gatewayBaseUrl, credentialTarget), 0o600);
    const login = spawnSync(config.grokBin, ["login"], {
      encoding: "utf8",
      env: { ...withoutEnvironmentKey(process.env, "GROK_HOME"), HOME: home, LLM_GATEWAY_CONFIG: configPath },
    });
    if (login.status !== 0) throw new Error(`Grok gateway login failed: ${login.stderr.trim() || login.stdout.trim() || `exit ${login.status ?? 1}`}`);
    if (!existsSync(grokAuth) || !ownerOnly(grokAuth)) throw new Error("Grok gateway login did not create owner-only authentication");
    if (removeLegacyGrok) {
      rmSync(legacyGrokTarget, { force: true });
      rmSync(legacyGrokHome, { recursive: true, force: true });
    }
  }
  await writeConfigEdits(gatewayEdits(config, credentialTarget));
  chmodSync(codexConfig, 0o600);
  atomicWriteJson(claudeSettings, desiredClaudeSettings);
  rmSync(legacyCredentialTarget, { force: true });
  const finalState = readState(statePath);
  process.stdout.write(`configured Codex and Claude gateway routing${config.cursorAgentBin ? " plus canonical Cursor API-key commands" : ""}${config.grokBin ? " plus canonical Grok gateway routing" : ""}; ${finalState.version >= 4 && finalState.authRetired ? "vendor logins remain retired" : "vendor login backups remain available"}\n`);
}

if (import.meta.main) {
  try {
    await run();
  } catch (error) {
    process.stderr.write(`FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
