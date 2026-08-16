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

type ClientConfig = {
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

type ClientState = ClientStateV1 | ClientStateV2;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceCredential = join(repoRoot, "scripts/agents/llm-client-credential.sh");
const sourceCursor = join(repoRoot, "scripts/agents/cursor-agent-api.sh");

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

export function parseClientConfig(contents: string): ClientConfig {
  const value: unknown = JSON.parse(contents);
  if (!isRecord(value) || !exactKeys(value, ["version", "secretFile", "gatewayBaseUrl", "cursorAgentBin"])) {
    throw new Error("client config must contain exactly version, secretFile, gatewayBaseUrl, and cursorAgentBin");
  }
  if (value.version !== 1) throw new Error("client config version must be 1");
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
  return value as ClientConfig;
}

export function gatewayEdits(config: ClientConfig, credentialPath: string): ConfigEdit[] {
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
    throw new Error("LLM client state has an invalid shape");
  }
  const v1 = value.version === 1 && exactKeys(value, ["version", "codexConfigExisted", "codexBackupPath"]);
  const v2 = value.version === 2 && exactKeys(value, ["version", "codexConfigExisted", "codexBackupPath", "cursorCommands"]);
  if (!v1 && !v2) throw new Error("LLM client state has an invalid shape");
  if (typeof value.codexConfigExisted !== "boolean" || !(value.codexBackupPath === null || typeof value.codexBackupPath === "string")) {
    throw new Error("LLM client state has invalid values");
  }
  if (v2) {
    if (!Array.isArray(value.cursorCommands) || value.cursorCommands.length !== 2) {
      throw new Error("LLM client state has invalid Cursor commands");
    }
    for (const command of value.cursorCommands) {
      if (!isRecord(command) || !exactKeys(command, ["path", "target"]) || typeof command.path !== "string" || typeof command.target !== "string") {
        throw new Error("LLM client state has invalid Cursor commands");
      }
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

function assertStateCursorCommands(state: ClientStateV2, expectedPaths: readonly string[]): void {
  if (!state.cursorCommands.every((command, index) => command.path === expectedPaths[index])) {
    throw new Error("LLM client state contains unexpected Cursor command paths");
  }
}

export function assertCursorAgentBinSafe(cursorAgentBin: string, managedPaths: readonly string[]): void {
  if (managedPaths.includes(resolve(cursorAgentBin))) {
    throw new Error("cursorAgentBin must point to Cursor's versioned vendor executable, not a managed launcher path");
  }
}

function validateLocalInputs(configPath: string): ClientConfig {
  if (!existsSync(configPath) || lstatSync(configPath).isSymbolicLink() || !lstatSync(configPath).isFile()) {
    throw new Error(`client config must be a regular file: ${configPath}`);
  }
  if (!ownerOnly(configPath)) throw new Error("client config must not be accessible by group or other users");
  const config = parseClientConfig(readFileSync(configPath, "utf8"));
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
  const mode = args.length === 0 ? "apply" : args.length === 1 && ["--check", "--rollback"].includes(args[0]) ? args[0].slice(2) : "invalid";
  if (mode === "invalid") throw new Error("usage: configure-llm-client.ts [--check|--rollback]");

  const home = resolve(process.env.HOME || "");
  const codexHome = resolve(process.env.CODEX_HOME || join(home, ".codex"));
  const codexConfig = resolve(process.env.CODEX_CONFIG_PATH || join(codexHome, "config.toml"));
  const configPath = resolve(process.env.LLM_CLIENT_CONFIG || join(home, ".config/dotfiles/llm-client.json"));
  const statePath = join(home, ".config/dotfiles/llm-client-state.json");
  const credentialTarget = join(home, ".local/libexec/dotfiles/llm-client-credential");
  const cursorApiTarget = join(home, ".local/bin/cursor-agent-api");
  const cursorCommandTargets = [join(home, ".local/bin/cursor-agent"), join(home, ".local/bin/agent")];
  const managedCursorTargets = [cursorApiTarget, ...cursorCommandTargets];
  const backupPath = `${codexConfig}.llm-client.backup`;

  if (mode === "rollback") {
    if (!existsSync(statePath)) {
      process.stdout.write("LLM client is already rolled back\n");
      return;
    }
    const state = readState(statePath);
    if (state.version === 2) assertStateCursorCommands(state, cursorCommandTargets);
    if (state.codexConfigExisted) {
      if (!state.codexBackupPath || !existsSync(state.codexBackupPath)) throw new Error("Codex rollback backup is missing");
      atomicCopy(state.codexBackupPath, codexConfig, 0o600);
    } else {
      rmSync(codexConfig, { force: true });
    }
    rmSync(credentialTarget, { force: true });
    rmSync(cursorApiTarget, { force: true });
    if (state.version === 2) restoreCursorCommands(state.cursorCommands);
    if (state.codexBackupPath) rmSync(state.codexBackupPath, { force: true });
    rmSync(statePath, { force: true });
    process.stdout.write("rolled back LLM client; saved Codex login remains untouched\n");
    return;
  }

  const config = validateLocalInputs(configPath);
  assertCursorAgentBinSafe(config.cursorAgentBin, managedCursorTargets);
  if (mode === "check") {
    if (!existsSync(statePath) || !ownerOnly(statePath)) throw new Error("LLM client state is missing or not owner-only");
    const state = readState(statePath);
    if (state.version !== 2) throw new Error("LLM client state must be upgraded by applying the configurator");
    assertStateCursorCommands(state, cursorCommandTargets);
    assertInstalledFile(sourceCredential, credentialTarget);
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
    for (const kind of ["cursor", "gateway"]) {
      const result = spawnSync(credentialTarget, [kind], { encoding: "utf8", env: { ...process.env, LLM_CLIENT_CONFIG: configPath } });
      if (result.status !== 0 || result.stdout.trim().length === 0) throw new Error(`${kind} credential helper failed`);
    }
    process.stdout.write("ok LLM client config, helpers, ciphertext, and Codex provider\n");
    return;
  }

  if (!existsSync(statePath)) {
    const cursorCommands = captureCursorCommands(cursorCommandTargets);
    const existed = existsSync(codexConfig);
    if (existed) {
      if (existsSync(backupPath)) throw new Error(`refusing to overwrite existing backup: ${backupPath}`);
      atomicCopy(codexConfig, backupPath, 0o600);
    }
    atomicWriteJson(statePath, {
      version: 2,
      codexConfigExisted: existed,
      codexBackupPath: existed ? backupPath : null,
      cursorCommands,
    } satisfies ClientStateV2);
  } else {
    const state = readState(statePath);
    if (state.version === 1) {
      atomicWriteJson(statePath, {
        version: 2,
        codexConfigExisted: state.codexConfigExisted,
        codexBackupPath: state.codexBackupPath,
        cursorCommands: captureCursorCommands(cursorCommandTargets),
      } satisfies ClientStateV2);
    } else {
      assertStateCursorCommands(state, cursorCommandTargets);
    }
  }

  atomicCopy(sourceCredential, credentialTarget, 0o700);
  for (const target of managedCursorTargets) atomicCopy(sourceCursor, target, 0o700);
  await writeConfigEdits(gatewayEdits(config, credentialTarget));
  chmodSync(codexConfig, 0o600);
  process.stdout.write("configured Codex gateway and canonical Cursor API-key commands; saved logins remain untouched\n");
}

if (import.meta.main) {
  try {
    await run();
  } catch (error) {
    process.stderr.write(`FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
