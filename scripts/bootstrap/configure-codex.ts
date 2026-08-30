#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { spawn } from "node:child_process";
import { Console, Effect, Schema } from "effect";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import readline from "node:readline";
import { runMain } from "../lib/program.ts";
import { profileModelFile, resolveProfile } from "../profiles/current.ts";
import { readProfileModelEffect, requireProfile } from "../profiles/model.ts";

type RpcMessage = { id?: number; result?: unknown; error?: { message?: string } };
const RpcMessage = Schema.Struct({
  id: Schema.optional(Schema.Number),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ message: Schema.optional(Schema.String) })),
});
type Scalar = boolean | null | number | string | readonly string[] | Readonly<Record<string, string>>;
export type ConfigEdit = { keyPath: string; value: Scalar; mergeStrategy: "replace" | "upsert" };

export function managedEdits(personal: boolean): ConfigEdit[] {
  return [
    { keyPath: "forced_login_method", value: null, mergeStrategy: "replace" },
    { keyPath: "model", value: "gpt-5.6-sol", mergeStrategy: "upsert" },
    { keyPath: "model_reasoning_effort", value: "medium", mergeStrategy: "upsert" },
    personal
      ? { keyPath: "service_tier", value: "fast", mergeStrategy: "upsert" }
      : { keyPath: "service_tier", value: null, mergeStrategy: "replace" },
    personal
      ? { keyPath: "features.fast_mode", value: true, mergeStrategy: "upsert" }
      : { keyPath: "features.fast_mode", value: null, mergeStrategy: "replace" },
    { keyPath: "features.goals", value: true, mergeStrategy: "upsert" },
    { keyPath: "features.memories", value: false, mergeStrategy: "upsert" },
  ];
}

export async function writeConfigEdits(edits: readonly ConfigEdit[]): Promise<string> {
  const codexHome = resolve(process.env.CODEX_HOME || join(process.env.HOME || "", ".codex"));
  const configPath = resolve(process.env.CODEX_CONFIG_PATH || join(codexHome, "config.toml"));
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });

  const child = spawn(process.env.CODEX_BIN || "codex", ["app-server"], {
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
        message = Schema.decodeUnknownSync(RpcMessage)(JSON.parse(line));
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

export async function configure(personal: boolean): Promise<string> {
  return writeConfigEdits(managedEdits(personal));
}

if (import.meta.main) {
  const program = Effect.gen(function*() {
    const args = process.argv.slice(2);
    const profileIndex = args.indexOf("--profile");
    if (args.length > 2 || (args.length > 0 && (profileIndex !== 0 || !args[1]))) {
      return yield* Effect.fail(new Error("usage: configure-codex.ts [--profile PROFILE]"));
    }
    const profile = yield* resolveProfile(profileIndex === 0 ? args[1] : undefined);
    const model = yield* readProfileModelEffect(profileModelFile());
    const personal = requireProfile(model, profile).capabilities.personal;
    const configPath = yield* Effect.tryPromise({
      try: () => configure(personal),
      catch: (error) => error,
    });
    yield* Console.log(`configured Codex defaults in ${configPath}`);
  });
  runMain(program.pipe(Effect.provide(NodeServices.layer)));
}
