#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type AuditScope = "repo" | "mscp" | "host" | "workstation" | "devbox";
export type AuditFormat = "text" | "json";

type Result = { error?: Error; status: number | null };
type Runner = (command: string, args: string[]) => Result;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scopes = new Set<AuditScope>(["repo", "mscp", "host", "workstation", "devbox"]);
const formats = new Set<AuditFormat>(["text", "json"]);

export function auditCommand(scope: AuditScope, format: AuditFormat): [string, string[]] {
  const script = scope === "mscp" ? "repo" : scope;
  const args = scope === "repo" ? ["--skip-mscp"] : [];
  if (format === "json") {
    args.push("--json");
  }
  return [process.execPath, [resolve(repoRoot, `scripts/audit/${script}.ts`), ...args]];
}

export function runAudit(scope: AuditScope, format: AuditFormat, run: Runner = defaultRunner): number {
  const [command, args] = auditCommand(scope, format);
  const result = run(command, args);
  if (result.error) {
    process.stderr.write(`FAILED: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

function defaultRunner(command: string, args: string[]): Result {
  return spawnSync(command, args, { cwd: repoRoot, stdio: "inherit" });
}

function main(args: string[]): number {
  const [scope, format] = args;
  if (args.length !== 2 || !scopes.has(scope as AuditScope) || !formats.has(format as AuditFormat)) {
    process.stderr.write("Usage: scripts/audit/run.ts <repo|mscp|host|workstation|devbox> <text|json>\n");
    return 2;
  }
  return runAudit(scope as AuditScope, format as AuditFormat);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
