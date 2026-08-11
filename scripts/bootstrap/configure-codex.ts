#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

type RpcMessage = { id?: number; result?: unknown; error?: { message?: string } };
type Scalar = boolean | number | string;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultsPath = join(scriptDir, "codex-defaults.json");

function readDefaults(path: string): Array<{ keyPath: string; value: Scalar; mergeStrategy: "upsert" }> {
  const document = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("Codex defaults must be an object");
  const { version, values } = document as { version?: unknown; values?: unknown };
  if (version !== 1 || !values || typeof values !== "object" || Array.isArray(values)) throw new Error("unsupported Codex defaults schema");
  return Object.entries(values).map(([keyPath, value]) => {
    if (!keyPath || !/^[A-Za-z0-9_.-]+$/.test(keyPath)) throw new Error(`invalid Codex config key: ${keyPath}`);
    if (!["boolean", "number", "string"].includes(typeof value)) throw new Error(`invalid Codex config value: ${keyPath}`);
    return { keyPath, value: value as Scalar, mergeStrategy: "upsert" };
  });
}

async function configure(): Promise<string> {
  const codexHome = resolve(process.env.CODEX_HOME || join(process.env.HOME || "", ".codex"));
  const configPath = resolve(process.env.CODEX_CONFIG_PATH || join(codexHome, "config.toml"));
  const edits = readDefaults(defaultsPath);
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });

  const child = spawn("codex", ["app-server"], {
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);

  await new Promise<void>((finish, reject) => {
    let completed = false;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      lines.close();
      child.stdin.end();
      child.kill();
      reject(error);
    };
    child.once("error", (error) => fail(error));
    child.once("close", (status) => {
      if (settled) return;
      settled = true;
      if (completed && status === 0) finish();
      else reject(new Error(stderr.trim() || `Codex app-server exited ${status ?? 1}`));
    });
    lines.on("line", (line) => {
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        fail(new Error("Codex app-server returned invalid JSON"));
        return;
      }
      if (message.id === 0) {
        if (message.error) return fail(new Error(message.error.message || "Codex app-server initialization failed"));
        send({ method: "initialized", params: {} });
        send({ method: "config/batchWrite", id: 1, params: { edits, filePath: configPath } });
      }
      if (message.id === 1) {
        if (message.error) return fail(new Error(message.error.message || "Codex config update failed"));
        completed = true;
        child.stdin.end();
      }
    });
    send({
      method: "initialize",
      id: 0,
      params: { clientInfo: { name: "dotfiles_bootstrap", title: "Dotfiles Bootstrap", version: "1" } },
    });
  });
  chmodSync(configPath, 0o600);
  return configPath;
}

try {
  const configPath = await configure();
  process.stdout.write(`configured Codex defaults in ${configPath}\n`);
} catch (error) {
  process.stderr.write(`FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
