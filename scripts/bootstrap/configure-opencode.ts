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
import { dirname, join, resolve } from "node:path";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const providers = ["opencode", "opencode-go"] as const;

function ownerOnly(path: string): boolean {
  return (lstatSync(path).mode & 0o077) === 0;
}

function isMatchingApi(entry: unknown, key: string): boolean {
  return isRecord(entry) && entry.type === "api" && entry.key === key;
}

function readOpenCodeKey(helper: string): string {
  if (!existsSync(helper) || lstatSync(helper).isSymbolicLink() || !lstatSync(helper).isFile()) {
    throw new Error(`credential helper must be a regular file: ${helper}`);
  }
  if ((lstatSync(helper).mode & 0o111) === 0) throw new Error("credential helper must be executable");
  const result = spawnSync(helper, ["opencode"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error("OpenCode credential helper failed");
  const key = result.stdout.trim();
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{20,}$/.test(key)) {
    throw new Error("credential helper returned an invalid OpenCode API key");
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
  if (args.length > (check ? 1 : 0)) throw new Error("usage: configure-opencode.ts [--check]");

  const home = resolve(process.env.HOME || "");
  const helper = resolve(
    process.env.OPENCODE_CREDENTIAL_HELPER || join(home, ".local/libexec/dotfiles/llm-gateway-credential"),
  );
  const authPath = resolve(process.env.OPENCODE_AUTH_PATH || join(home, ".local/share/opencode/auth.json"));
  const key = readOpenCodeKey(helper);
  const auth = readAuth(authPath);
  const credential = { type: "api", key };

  if (check) {
    if (!ownerOnly(authPath) || providers.some((provider) => !isMatchingApi(auth[provider], key))) {
      throw new Error("OpenCode authentication drifted");
    }
    process.stdout.write("ok OpenCode credential matches the resolved local credential\n");
    return;
  }

  atomicWriteJson(authPath, { ...auth, opencode: credential, "opencode-go": credential });
  process.stdout.write("configured OpenCode authentication\n");
}

try {
  run();
} catch (error) {
  process.stderr.write(`FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
