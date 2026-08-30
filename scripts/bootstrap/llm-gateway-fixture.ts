import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const script = resolve(dirname(fileURLToPath(import.meta.url)), "configure-llm-gateway.ts");
export const codexInstalled = spawnSync("codex", ["--version"], { stdio: "ignore" }).status === 0;

export function fixturePath(bin: string): string {
  const ambient = (process.env.PATH || "").split(":").filter((entry) => entry && !entry.endsWith("/mise/shims"));
  return [bin, ...ambient].join(":");
}

export const validConfig = {
  version: 3 as const,
  credentials: {
    gatewai: "0123456789abcdefghijklmnopqrstuvwxyz_ABCD",
    bifrost: "sk-bf-11111111-1111-4111-8111-111111111111",
    cursor: "crsr_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-",
  },
  gatewaiBaseUrl: "https://gatewai.example/v1",
  bifrostBaseUrl: "https://bifrost.example/v1",
  cursorAgentBin: "/Users/example/.local/bin/agent",
};
