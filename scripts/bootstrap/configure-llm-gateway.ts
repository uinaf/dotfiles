#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { Effect } from "effect";
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

import { runMain } from "../lib/program.ts";
import { type ConfigEdit, writeConfigEdits } from "./configure-codex.ts";

type PreservedLogin = "codex" | "claude" | "cursor" | "grok";

type GatewayConfig = {
  version: 3;
  credentials: {
    gatewai: string;
    bifrost: string;
    cursor?: string;
  };
  gatewaiBaseUrl: string;
  bifrostBaseUrl: string;
  cursorAgentBin?: string;
  grokBin?: string;
  preservedLogins?: PreservedLogin[];
};

type CursorCommandState = {
  path: string;
  target: string;
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

type ClientState = ClientStateV6;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceCredential = join(repoRoot, "scripts/agents/llm-gateway-credential.sh");
const sourceCodexGatewai = join(repoRoot, "scripts/agents/codex-gatewai.sh");
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
  const allowed = new Set(["version", "credentials", "gatewaiBaseUrl", "bifrostBaseUrl", "cursorAgentBin", "grokBin", "preservedLogins"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("gateway config contains an unknown field");
  }
  if (value.version !== 3) throw new Error("gateway config version must be 3");
  if (typeof value.gatewaiBaseUrl !== "string" || value.gatewaiBaseUrl.length === 0) {
    throw new Error("gatewaiBaseUrl must be a non-empty string");
  }
  if (typeof value.bifrostBaseUrl !== "string" || value.bifrostBaseUrl.length === 0) {
    throw new Error("bifrostBaseUrl must be a non-empty string");
  }
  if (!isRecord(value.credentials)) throw new Error("credentials must contain an object of resolved strings");
  const credentialKeys = Object.keys(value.credentials);
  if (credentialKeys.some((key) => !["gatewai", "bifrost", "cursor"].includes(key))) {
    throw new Error("credentials contains an unknown field");
  }
  if (typeof value.credentials.gatewai !== "string" || !/^[A-Za-z0-9_-]{32,}$/.test(value.credentials.gatewai)) {
    throw new Error("credentials.gatewai must be a resolved Gatewai key");
  }
  if (typeof value.credentials.bifrost !== "string" ||
    !/^sk-bf-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.credentials.bifrost)) {
    throw new Error("credentials.bifrost must be a resolved Bifrost key");
  }
  if (value.credentials.cursor !== undefined &&
    (typeof value.credentials.cursor !== "string" || !/^crsr_[A-Za-z0-9_-]{64}$/.test(value.credentials.cursor))) {
    throw new Error("credentials.cursor must be a resolved Cursor key when configured");
  }
  for (const field of ["cursorAgentBin", "grokBin"] as const) {
    if (value[field] !== undefined && (typeof value[field] !== "string" || value[field].length === 0 || !isAbsolute(value[field]))) {
      throw new Error(`${field} must be an absolute path when configured`);
    }
  }
  if ((value.cursorAgentBin === undefined) !== (value.credentials.cursor === undefined)) {
    throw new Error("cursorAgentBin and credentials.cursor must be configured together");
  }
  if (value.preservedLogins !== undefined) {
    const known: readonly string[] = ["codex", "claude", "cursor", "grok"];
    if (!Array.isArray(value.preservedLogins)
      || value.preservedLogins.some((entry) => typeof entry !== "string" || !known.includes(entry))
      || new Set(value.preservedLogins).size !== value.preservedLogins.length) {
      throw new Error("preservedLogins must list unique clients from codex, claude, cursor, grok");
    }
  }
  for (const field of ["gatewaiBaseUrl", "bifrostBaseUrl"] as const) {
    const fieldValue = value[field];
    if (typeof fieldValue !== "string") throw new Error(`${field} must be a non-empty string`);
    const url = new URL(fieldValue);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/v1")) {
      throw new Error(`${field} must be an HTTPS /v1 URL without credentials, query, or fragment`);
    }
  }
  return value as GatewayConfig;
}

export function gatewayEdits(config: GatewayConfig, credentialPath: string): ConfigEdit[] {
  return [
    { keyPath: "model", value: "gpt-5.6-sol", mergeStrategy: "upsert" },
    { keyPath: "model_provider", value: "gatewai", mergeStrategy: "upsert" },
    { keyPath: "features.apps", value: false, mergeStrategy: "upsert" },
    { keyPath: "mcp_servers.node_repl", value: null, mergeStrategy: "replace" },
    { keyPath: "mcp_servers.computer-use", value: null, mergeStrategy: "replace" },
    { keyPath: "notify", value: null, mergeStrategy: "replace" },
    { keyPath: "model_providers.llm_gateway", value: null, mergeStrategy: "replace" },
    { keyPath: "model_providers.gatewai.name", value: "Gatewai", mergeStrategy: "upsert" },
    { keyPath: "model_providers.gatewai.base_url", value: config.gatewaiBaseUrl, mergeStrategy: "upsert" },
    { keyPath: "model_providers.gatewai.wire_api", value: "responses", mergeStrategy: "upsert" },
    { keyPath: "model_providers.gatewai.requires_openai_auth", value: false, mergeStrategy: "upsert" },
    { keyPath: "model_providers.gatewai.supports_websockets", value: true, mergeStrategy: "upsert" },
    {
      keyPath: "model_providers.gatewai.http_headers",
      value: { "X-OpenAI-Actor-Authorization": "local-proxy" },
      mergeStrategy: "upsert",
    },
    { keyPath: "model_providers.gatewai.auth.command", value: credentialPath, mergeStrategy: "upsert" },
    { keyPath: "model_providers.gatewai.auth.args", value: ["gatewai"], mergeStrategy: "upsert" },
    { keyPath: "model_providers.gatewai.auth.timeout_ms", value: 5000, mergeStrategy: "upsert" },
    { keyPath: "model_providers.gatewai.auth.refresh_interval_ms", value: 0, mergeStrategy: "upsert" },
    { keyPath: "model_providers.bifrost.name", value: "Bifrost", mergeStrategy: "upsert" },
    { keyPath: "model_providers.bifrost.base_url", value: config.bifrostBaseUrl, mergeStrategy: "upsert" },
    { keyPath: "model_providers.bifrost.wire_api", value: "responses", mergeStrategy: "upsert" },
    { keyPath: "model_providers.bifrost.requires_openai_auth", value: false, mergeStrategy: "upsert" },
    { keyPath: "model_providers.bifrost.supports_websockets", value: false, mergeStrategy: "upsert" },
    { keyPath: "model_providers.bifrost.auth.command", value: credentialPath, mergeStrategy: "upsert" },
    { keyPath: "model_providers.bifrost.auth.args", value: ["bifrost"], mergeStrategy: "upsert" },
    { keyPath: "model_providers.bifrost.auth.timeout_ms", value: 5000, mergeStrategy: "upsert" },
    { keyPath: "model_providers.bifrost.auth.refresh_interval_ms", value: 0, mergeStrategy: "upsert" },
  ];
}

export function codexGatewaiOverrides(config: GatewayConfig, credentialPath: string): string[] {
  const serialize = (value: ConfigEdit["value"]): string => JSON.stringify(value);
  return gatewayEdits(config, credentialPath)
    .filter((edit) => edit.keyPath === "model_provider" || edit.keyPath.startsWith("model_providers.gatewai."))
    .map((edit) => `${edit.keyPath}=${serialize(edit.value)}`);
}

export function claudeGatewayBaseUrl(gatewaiBaseUrl: string): string {
  const url = new URL(gatewaiBaseUrl);
  url.pathname = url.pathname.slice(0, -3) || "/";
  return url.toString().replace(/\/$/, "");
}

export function claudeGatewaySettings(contents: string, gatewaiBaseUrl: string, credentialPath: string): Record<string, unknown> {
  const value: unknown = contents.trim() === "" ? {} : JSON.parse(contents);
  if (!isRecord(value)) throw new Error("Claude settings must contain a JSON object");
  const currentEnv = value.env === undefined ? {} : value.env;
  if (!isRecord(currentEnv)) throw new Error("Claude settings env must contain a JSON object");
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]) {
    if (key in currentEnv) throw new Error(`Claude settings env conflicts with the gateway: ${key}`);
  }
  return {
    ...value,
    apiKeyHelper: `${credentialPath} gatewai`,
    env: { ...currentEnv, ANTHROPIC_BASE_URL: claudeGatewayBaseUrl(gatewaiBaseUrl) },
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
  if (!v6) throw new Error("LLM gateway state has an invalid shape; roll back and re-enroll pre-v6 hosts");
  if (typeof value.codexConfigExisted !== "boolean" || !(value.codexBackupPath === null || typeof value.codexBackupPath === "string")) {
    throw new Error("LLM gateway state has invalid values");
  }
  if (!Array.isArray(value.cursorCommands) || ![0, 2].includes(value.cursorCommands.length)) {
    throw new Error("LLM gateway state has invalid Cursor commands");
  }
  for (const command of value.cursorCommands) {
    if (!isRecord(command) || !exactKeys(command, ["path", "target"]) || typeof command.path !== "string" || typeof command.target !== "string") {
      throw new Error("LLM gateway state has invalid Cursor commands");
    }
  }
  if (typeof value.claudeSettingsExisted !== "boolean" || !(value.claudeBackupPath === null || typeof value.claudeBackupPath === "string")) {
    throw new Error("LLM gateway state has invalid Claude settings values");
  }
  if (typeof value.authRetired !== "boolean") throw new Error("LLM gateway state has an invalid auth retirement value");
  if (typeof value.grokEnabled !== "boolean") throw new Error("LLM gateway state has an invalid Grok value");
  if (typeof value.grokConfigExisted !== "boolean" || !(value.grokConfigBackupPath === null || typeof value.grokConfigBackupPath === "string")) {
    throw new Error("LLM gateway state has invalid Grok config values");
  }
  if (typeof value.grokAuthExisted !== "boolean" || !(value.grokAuthBackupPath === null || typeof value.grokAuthBackupPath === "string")) {
    throw new Error("LLM gateway state has invalid Grok auth values");
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

function assertStateCursorCommands(state: ClientState, expectedPaths: readonly string[], enabled = true): void {
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

function grokGatewayBlock(gatewaiBaseUrl: string, credentialPath: string): string {
  return [
    grokGatewayBegin,
    "[models]",
    'default = "grok-4.6"',
    "",
    "[endpoints]",
    `models_base_url = ${JSON.stringify(gatewaiBaseUrl)}`,
    "",
    "[auth]",
    `auth_provider_command = ${JSON.stringify(`${credentialPath} gatewai`)}`,
    'auth_provider_label = "Gatewai"',
    "auth_token_ttl = 3600",
    "",
    '[model."grok-4.6"]',
    'api_backend = "responses"',
    grokGatewayEnd,
  ].join("\n");
}

export function grokGatewaySettings(contents: string, gatewaiBaseUrl: string, credentialPath: string): string {
  const managed = new RegExp(`${grokGatewayBegin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${grokGatewayEnd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`, "g");
  const original = contents.replace(managed, "").trimEnd();
  for (const section of ["models", "endpoints", "auth", 'model."grok-4.6"']) {
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`^\\s*\\[${escaped}\\]\\s*$`, "m").test(original)) {
      throw new Error(`Grok config conflicts with gateway section: ${section}`);
    }
  }
  return `${original}${original ? "\n\n" : ""}${grokGatewayBlock(gatewaiBaseUrl, credentialPath)}\n`;
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
  const credentialTarget = join(home, ".local/libexec/dotfiles/llm-gateway-credential");
  const codexGatewaiTarget = join(home, ".local/libexec/dotfiles/codex-gatewai");
  const cursorAcpAuthTarget = join(home, ".local/libexec/dotfiles/cursor-acp-api-key-auth");
  const cursorApiTarget = join(home, ".local/libexec/dotfiles/cursor-agent-api");
  const cursorApiCompatibilityTarget = join(home, ".local/bin/cursor-agent-api");
  const cursorCommandTargets = [join(home, ".local/bin/cursor-agent"), join(home, ".local/bin/agent")];
  const cursorAuth = join(home, ".cursor/auth.json");
  const managedCursorTargets = [cursorApiTarget, cursorApiCompatibilityTarget, ...cursorCommandTargets];
  const grokHome = join(home, ".grok");
  const grokConfig = join(grokHome, "config.toml");
  const grokAuth = join(grokHome, "auth.json");
  const codexBackupPath = `${codexConfig}.llm-gateway.backup`;
  const claudeBackupPath = `${claudeSettings}.llm-gateway.backup`;
  const grokConfigBackupPath = `${grokConfig}.llm-gateway.backup`;
  const grokAuthBackupPath = `${grokAuth}.llm-gateway.backup`;

  if (mode === "rollback") {
    if (!existsSync(statePath)) {
      process.stdout.write("LLM gateway is already rolled back\n");
      return;
    }
    const state = readState(statePath);
    assertStateCursorCommands(state, cursorCommandTargets, state.cursorCommands.length > 0);
    if (state.codexConfigExisted) {
      if (!state.codexBackupPath || !existsSync(state.codexBackupPath)) throw new Error("Codex rollback backup is missing");
      atomicCopy(state.codexBackupPath, codexConfig, 0o600);
    } else {
      rmSync(codexConfig, { force: true });
    }
    if (state.claudeSettingsExisted) {
      if (!state.claudeBackupPath || !existsSync(state.claudeBackupPath)) throw new Error("Claude rollback backup is missing");
      atomicCopy(state.claudeBackupPath, claudeSettings, 0o600);
    } else {
      rmSync(claudeSettings, { force: true });
    }
    rmSync(credentialTarget, { force: true });
    rmSync(codexGatewaiTarget, { force: true });
    rmSync(cursorAcpAuthTarget, { force: true });
    rmSync(cursorApiTarget, { force: true });
    rmSync(cursorApiCompatibilityTarget, { force: true });
    if (state.cursorCommands.length > 0) restoreCursorCommands(state.cursorCommands);
    if (state.grokEnabled) {
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
    if (state.claudeBackupPath) rmSync(state.claudeBackupPath, { force: true });
    if (state.grokConfigBackupPath) rmSync(state.grokConfigBackupPath, { force: true });
    if (state.grokAuthBackupPath) rmSync(state.grokAuthBackupPath, { force: true });
    rmSync(statePath, { force: true });
    process.stdout.write(state.authRetired
      ? "rolled back LLM gateway; coding login state was retired and requires reauthentication\n"
      : "rolled back LLM gateway; saved Codex, Claude, and Grok login state remains available\n");
    return;
  }

  const config = validateLocalInputs(configPath);
  if (config.cursorAgentBin) assertCursorAgentBinSafe(config.cursorAgentBin, managedCursorTargets);
  const desiredClaudeSettings = claudeGatewaySettings(
    existsSync(claudeSettings) ? readFileSync(claudeSettings, "utf8") : "",
    config.gatewaiBaseUrl,
    credentialTarget,
  );
  if (mode === "check" || mode === "retire-auth") {
    if (!existsSync(statePath) || !ownerOnly(statePath)) throw new Error("LLM gateway state is missing or not owner-only");
    const state = readState(statePath);
    assertStateCursorCommands(state, cursorCommandTargets, Boolean(config.cursorAgentBin));
    assertInstalledFile(sourceCredential, credentialTarget);
    assertInstalledFile(sourceCodexGatewai, codexGatewaiTarget);
    const overridesProbe = spawnSync(codexGatewaiTarget, ["--gateway-overrides"], {
      encoding: "utf8",
      env: { ...process.env, LLM_GATEWAY_CONFIG: configPath },
    });
    const launcherOverrides = overridesProbe.stdout.trim().split("\n").sort();
    const expectedOverrides = [...codexGatewaiOverrides(config, credentialTarget)].sort();
    if (overridesProbe.status !== 0 || JSON.stringify(launcherOverrides) !== JSON.stringify(expectedOverrides)) {
      throw new Error("codex-gatewai launcher overrides drifted from the Codex gateway config edits");
    }
    if (config.cursorAgentBin) {
      assertInstalledFile(sourceCursorAcpAuth, cursorAcpAuthTarget);
      for (const target of managedCursorTargets) assertInstalledFile(sourceCursor, target);
    }
    if (config.grokBin) {
      const originalGrokConfig = state.grokConfigExisted
        ? readFileSync(state.grokConfigBackupPath || "", "utf8")
        : "";
      if (!existsSync(grokConfig) || readFileSync(grokConfig, "utf8") !== grokGatewaySettings(originalGrokConfig, config.gatewaiBaseUrl, credentialTarget)) {
        throw new Error("Grok gateway config drifted");
      }
      if (!existsSync(grokAuth) || !ownerOnly(grokAuth)) throw new Error("Grok gateway authentication is missing or not owner-only");
    }
    const contents = readFileSync(codexConfig, "utf8");
    for (const expected of [
      'model_provider = "gatewai"',
      config.gatewaiBaseUrl,
      config.bifrostBaseUrl,
      credentialTarget,
      '[model_providers.gatewai.auth]',
      'X-OpenAI-Actor-Authorization = "local-proxy"',
      'args = ["gatewai"]',
      '[model_providers.bifrost.auth]',
      'args = ["bifrost"]',
    ]) {
      if (!contents.includes(expected)) throw new Error("Codex gateway config drifted");
    }
    const claude = JSON.parse(readFileSync(claudeSettings, "utf8")) as { apiKeyHelper?: unknown; env?: Record<string, unknown> };
    if (claude.apiKeyHelper !== `${credentialTarget} gatewai` || claude.env?.ANTHROPIC_BASE_URL !== claudeGatewayBaseUrl(config.gatewaiBaseUrl)) {
      throw new Error("Claude gateway settings drifted");
    }
    const credentialKinds = ["gatewai", "bifrost"];
    if (config.cursorAgentBin) credentialKinds.push("cursor");
    for (const kind of credentialKinds) {
      const result = spawnSync(credentialTarget, [kind], { encoding: "utf8", env: { ...process.env, LLM_GATEWAY_CONFIG: configPath } });
      if (result.status !== 0 || result.stdout.trim().length === 0) {
        const detail = result.stderr.trim() || `exit ${result.status ?? "unknown"} without output`;
        throw new Error(`${kind} credential helper failed: ${detail}`);
      }
    }
    const preserved = new Set<PreservedLogin>(config.preservedLogins ?? []);
    if (mode === "check" && state.authRetired) {
      const logins = [["Codex", "codex", codexAuth], ["Claude", "claude", claudeAuth], ["Cursor", "cursor", cursorAuth]] as const;
      for (const [label, kind, path] of logins) {
        if (!preserved.has(kind) && existsSync(path)) throw new Error(`${label} saved login state remains after retirement`);
      }
      if (!preserved.has("grok") && state.grokAuthBackupPath && existsSync(state.grokAuthBackupPath)) {
        throw new Error("Grok saved vendor login remains after retirement");
      }
    }
    if (mode === "check") {
      const preservedNote = preserved.size > 0 ? `, preserved-logins=${[...preserved].sort().join("+")}` : "";
      process.stdout.write(`ok Gatewai/Bifrost config, helpers, resolved credentials, Codex and Claude on Gatewai, Cursor=${Boolean(config.cursorAgentBin)}, Grok=${Boolean(config.grokBin)}, and auth-retired=${state.authRetired}${preservedNote}\n`);
      return;
    }

    const returnedAuth = state.authRetired && (
      (!preserved.has("codex") && existsSync(codexAuth)) ||
      (!preserved.has("claude") && existsSync(claudeAuth)) ||
      (!preserved.has("cursor") && Boolean(config.cursorAgentBin) && existsSync(cursorAuth)) ||
      (!preserved.has("grok") && Boolean(state.grokAuthBackupPath && existsSync(state.grokAuthBackupPath)))
    );
    if (state.authRetired && !returnedAuth) {
      process.stdout.write("coding vendor login state is already retired; gateway routing remains configured\n");
      return;
    }

    if (!preserved.has("codex") && (!state.authRetired || existsSync(codexAuth))) {
      runLogout(process.env.CODEX_BIN || "codex", ["logout"], { ...process.env, CODEX_HOME: codexHome }, "Codex");
    }
    if (!preserved.has("claude") && (!state.authRetired || existsSync(claudeAuth))) {
      runLogout("claude", ["auth", "logout"], process.env, "Claude");
    }
    if (!preserved.has("cursor") && config.cursorAgentBin && (!state.authRetired || existsSync(cursorAuth))) {
      runLogout(
        config.cursorAgentBin,
        ["logout"],
        { ...withoutEnvironmentKey(process.env, "CURSOR_API_KEY"), AGENT_CLI_CREDENTIAL_STORE: "file" },
        "Cursor",
      );
    }
    await writeConfigEdits([{ keyPath: "forced_login_method", value: null, mergeStrategy: "replace" }]);
    const retireGrok = !preserved.has("grok");
    if (retireGrok && state.grokAuthBackupPath) rmSync(state.grokAuthBackupPath, { force: true });
    atomicWriteJson(statePath, {
      ...state,
      authRetired: true,
      grokAuthExisted: retireGrok ? false : state.grokAuthExisted,
      grokAuthBackupPath: retireGrok ? null : state.grokAuthBackupPath,
    } satisfies ClientStateV6);
    process.stdout.write(state.authRetired
      ? "retired returned coding vendor login state; gateway routing remains configured\n"
      : `retired saved Codex, Claude${config.cursorAgentBin ? ", Cursor" : ""}, and Grok vendor logins; gateway routing remains configured\n`);
    return;
  }

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
    assertStateCursorCommands(state, cursorCommandTargets, Boolean(config.cursorAgentBin));
    if (state.grokEnabled !== Boolean(config.grokBin)) {
      throw new Error("Grok enrollment changed; roll back before changing the client set");
    }
  }

  atomicCopy(sourceCredential, credentialTarget, 0o700);
  atomicCopy(sourceCodexGatewai, codexGatewaiTarget, 0o700);
  if (config.cursorAgentBin) {
    atomicCopy(sourceCursorAcpAuth, cursorAcpAuthTarget, 0o700);
    for (const target of managedCursorTargets) atomicCopy(sourceCursor, target, 0o700);
  }
  if (config.grokBin) {
    const state = readState(statePath);
    const originalGrokConfig = state.grokConfigExisted
      ? readFileSync(state.grokConfigBackupPath || "", "utf8")
      : "";
    atomicWriteText(grokConfig, grokGatewaySettings(originalGrokConfig, config.gatewaiBaseUrl, credentialTarget), 0o600);
    const login = spawnSync(config.grokBin, ["login"], {
      encoding: "utf8",
      env: { ...withoutEnvironmentKey(process.env, "GROK_HOME"), HOME: home, LLM_GATEWAY_CONFIG: configPath },
    });
    if (login.status !== 0) throw new Error(`Grok gateway login failed: ${login.stderr.trim() || login.stdout.trim() || `exit ${login.status ?? 1}`}`);
    if (!existsSync(grokAuth) || !ownerOnly(grokAuth)) throw new Error("Grok gateway login did not create owner-only authentication");
  }
  await writeConfigEdits(gatewayEdits(config, credentialTarget));
  chmodSync(codexConfig, 0o600);
  atomicWriteJson(claudeSettings, desiredClaudeSettings);
  const finalState = readState(statePath);
  process.stdout.write(`configured Codex and Claude gateway routing${config.cursorAgentBin ? " plus canonical Cursor API-key commands" : ""}${config.grokBin ? " plus canonical Grok gateway routing" : ""}; ${finalState.authRetired ? "vendor logins remain retired" : "vendor login backups remain available"}\n`);
}

if (import.meta.main) {
  runMain(Effect.tryPromise({ try: run, catch: (error) => error }));
}
