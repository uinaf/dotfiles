#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

type Gate = "deterministic" | "history";

type Check = {
  id: string;
  domain: string;
  gate?: Gate;
  scope?: "complete";
  command: string[];
  inputs: string[];
  output: string;
};

type Registry = {
  version: number;
  checks: Check[];
};

type Result = {
  check: Check;
  durationMs: number;
  status: number;
  output: string;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const registryPath = resolve(repoRoot, "scripts/verify/checks.json");

function fail(message: string): never {
  process.stderr.write(`FAILED: ${message}\n`);
  process.exit(1);
}

function usage(): void {
  process.stdout.write(`Usage:
  scripts/verify/repo.sh [--skip-security] [--domain NAME ...]
  scripts/verify/repo.sh --list [--json]

Without --domain, runs every deterministic check in parallel. The full-history
secret scan runs afterwards unless --skip-security is set. A focused domain
omits complete-only parity checks; request --domain security explicitly for
secret scans.
`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0);
}

function readRegistry(): Registry {
  const value: unknown = JSON.parse(readFileSync(registryPath, "utf8"));
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.checks) || value.checks.length === 0) {
    fail(`${registryPath} must contain a non-empty version 1 check registry`);
  }

  const ids = new Set<string>();
  const checks = value.checks.map((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      typeof candidate.domain !== "string" ||
      !isStringArray(candidate.command) ||
      !isStringArray(candidate.inputs) ||
      typeof candidate.output !== "string" ||
      candidate.output.length === 0 ||
      (candidate.scope !== undefined && candidate.scope !== "complete") ||
      (candidate.gate !== undefined && candidate.gate !== "deterministic" && candidate.gate !== "history")
    ) {
      fail(`${registryPath} contains an invalid check`);
    }
    if (ids.has(candidate.id)) {
      fail(`${registryPath} contains duplicate check id ${candidate.id}`);
    }
    ids.add(candidate.id);
    return {
      id: candidate.id,
      domain: candidate.domain,
      gate: candidate.gate,
      scope: candidate.scope,
      command: candidate.command,
      inputs: candidate.inputs,
      output: candidate.output,
    };
  });

  return { version: 1, checks };
}

function runCheck(check: Check): Promise<Result> {
  const [command, ...args] = check.command;
  const started = performance.now();

  return new Promise((finish) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", (error) => {
      chunks.push(Buffer.from(`${error.message}\n`));
      finish({
        check,
        durationMs: performance.now() - started,
        status: 1,
        output: Buffer.concat(chunks).toString(),
      });
    });
    child.on("close", (status) => {
      finish({
        check,
        durationMs: performance.now() - started,
        status: status ?? 1,
        output: Buffer.concat(chunks).toString(),
      });
    });
  });
}

async function runChecks(checks: Check[]): Promise<boolean> {
  if (checks.length === 0) {
    return true;
  }

  const results = await Promise.all(checks.map(runCheck));
  let passed = true;

  for (const result of results) {
    const seconds = (result.durationMs / 1000).toFixed(2);
    if (result.status === 0) {
      process.stdout.write(`ok ${result.check.id} (${seconds}s)\n`);
      continue;
    }

    passed = false;
    process.stderr.write(`\n## ${result.check.id}\n${result.output}`);
    if (!result.output.endsWith("\n")) {
      process.stderr.write("\n");
    }
    process.stderr.write(`FAILED: ${result.check.id} exited ${result.status} (${seconds}s)\n`);
  }

  return passed;
}

async function main(): Promise<void> {
  const registry = readRegistry();
  const requestedDomains = new Set<string>();
  let skipSecurity = false;
  let list = false;
  let json = false;

  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    switch (argument) {
      case "--domain": {
        const domain = process.argv[index + 1];
        if (!domain) {
          usage();
          process.exit(2);
        }
        requestedDomains.add(domain);
        index += 1;
        break;
      }
      case "--skip-security":
        skipSecurity = true;
        break;
      case "--list":
        list = true;
        break;
      case "--json":
        json = true;
        break;
      case "-h":
      case "--help":
        usage();
        return;
      default:
        usage();
        process.exit(2);
    }
  }

  const domains = [...new Set(registry.checks.map((check) => check.domain))].sort();
  for (const domain of requestedDomains) {
    if (!domains.includes(domain)) {
      fail(`unknown verification domain ${domain}; choose from ${domains.join(", ")}`);
    }
  }

  if (list) {
    if (json) {
      process.stdout.write(`${JSON.stringify(registry, null, 2)}\n`);
    } else {
      for (const domain of domains) {
        process.stdout.write(`${domain}\n`);
        for (const check of registry.checks.filter((candidate) => candidate.domain === domain)) {
          process.stdout.write(`  ${check.id}${check.scope === "complete" ? " [complete only]" : ""}: ${check.output}\n`);
          process.stdout.write(`    inputs: ${check.inputs.join(", ")}\n`);
        }
      }
    }
    return;
  }

  const focused = requestedDomains.size > 0;
  const selected = registry.checks.filter((check) => {
    if (check.gate === "history" && skipSecurity) {
      return false;
    }
    if (focused) {
      return check.scope !== "complete" && requestedDomains.has(check.domain);
    }
    return true;
  });
  const deterministic = selected.filter((check) => check.gate !== "history");
  const history = selected.filter((check) => check.gate === "history");
  const started = performance.now();

  if (!(await runChecks(deterministic))) {
    process.exit(1);
  }
  if (!(await runChecks(history))) {
    process.exit(1);
  }

  process.stdout.write(`verification ok (${((performance.now() - started) / 1000).toFixed(2)}s)\n`);
}

await main();
