#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import readline from "node:readline";

type RpcMessage = { id?: number; result?: unknown; error?: { message?: string } };
type Scalar = boolean | number | string;
type ConfigEdit = { keyPath: string; value: Scalar; mergeStrategy: "upsert" };

export const managedEdits = [
  { keyPath: "forced_login_method", value: "chatgpt", mergeStrategy: "upsert" },
  { keyPath: "model", value: "gpt-5.6-sol", mergeStrategy: "upsert" },
  { keyPath: "model_reasoning_effort", value: "high", mergeStrategy: "upsert" },
  { keyPath: "service_tier", value: "default", mergeStrategy: "upsert" },
  { keyPath: "features.fast_mode", value: false, mergeStrategy: "upsert" },
  { keyPath: "features.goals", value: true, mergeStrategy: "upsert" },
  { keyPath: "features.memories", value: true, mergeStrategy: "upsert" },
] satisfies ConfigEdit[];

export async function configure(): Promise<string> {
  const codexHome = resolve(process.env.CODEX_HOME || join(process.env.HOME || "", ".codex"));
  const configPath = resolve(process.env.CODEX_CONFIG_PATH || join(codexHome, "config.toml"));
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
        send({ method: "config/batchWrite", id: 1, params: { edits: managedEdits, filePath: configPath } });
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

if (import.meta.main) {
  try {
    const configPath = await configure();
    process.stdout.write(`configured Codex defaults in ${configPath}\n`);
  } catch (error) {
    process.stderr.write(`FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
