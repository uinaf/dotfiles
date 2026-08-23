#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

type LocalConfig = {
  secretFile: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownerOnly(path: string): boolean {
  return (lstatSync(path).mode & 0o077) === 0;
}

function readLocalConfig(path: string): LocalConfig {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new Error(`LLM gateway config must be a regular file: ${path}`);
  }
  if (!ownerOnly(path)) throw new Error("LLM gateway config must not be accessible by group or other users");

  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value) || typeof value.secretFile !== "string" || !isAbsolute(value.secretFile)) {
    throw new Error("LLM gateway config must contain an absolute secretFile path");
  }
  if (!existsSync(value.secretFile) || lstatSync(value.secretFile).isSymbolicLink() || !lstatSync(value.secretFile).isFile()) {
    throw new Error("secretFile must be a regular SOPS payload");
  }
  return { secretFile: value.secretFile };
}

function readZenKey(secretFile: string): string {
  const status = spawnSync("sops", ["filestatus", secretFile], { encoding: "utf8" });
  if (status.status !== 0 || !/"encrypted"\s*:\s*true/.test(status.stdout)) {
    throw new Error("secretFile is not encrypted SOPS data");
  }

  const decrypted = spawnSync("sops", ["decrypt", "--output-type", "json", secretFile], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (decrypted.status !== 0) throw new Error("could not decrypt the OpenCode Zen credential");

  let payload: unknown;
  try {
    payload = JSON.parse(decrypted.stdout);
  } catch {
    throw new Error("SOPS payload is not valid JSON");
  }
  const key = isRecord(payload) ? payload.OPENCODE_ZEN_API_KEY : undefined;
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{20,}$/.test(key)) {
    throw new Error("SOPS payload has an invalid OPENCODE_ZEN_API_KEY");
  }
  return key;
}

function readAuth(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new Error(`OpenCode auth must be a regular file: ${path}`);
  }
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value)) throw new Error("OpenCode auth must contain a JSON object");
  return value;
}

function atomicWriteJson(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function run(): void {
  const args = process.argv.slice(2);
  const check = args.length === 1 && args[0] === "--check";
  if (args.length > (check ? 1 : 0)) throw new Error("usage: configure-opencode-zen.ts [--check]");

  const home = resolve(process.env.HOME || "");
  const configPath = resolve(process.env.LLM_GATEWAY_CONFIG || join(home, ".config/dotfiles/llm-gateway.json"));
  const authPath = resolve(process.env.OPENCODE_AUTH_PATH || join(home, ".local/share/opencode/auth.json"));
  const config = readLocalConfig(configPath);
  const key = readZenKey(config.secretFile);
  const auth = readAuth(authPath);
  const current = auth.opencode;

  if (check) {
    if (!isRecord(current) || current.type !== "api" || current.key !== key || !ownerOnly(authPath)) {
      throw new Error("OpenCode Zen authentication drifted");
    }
    process.stdout.write("ok OpenCode Zen credential matches the encrypted identity payload\n");
    return;
  }

  atomicWriteJson(authPath, { ...auth, opencode: { type: "api", key } });
  process.stdout.write("configured OpenCode Zen authentication\n");
}

try {
  run();
} catch (error) {
  process.stderr.write(`FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
