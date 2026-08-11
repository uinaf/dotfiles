#!/usr/bin/env node

import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Finding = Record<string, unknown>;
type RuleCounts = Record<string, number>;
type Severity = "low" | "medium" | "high" | "critical";

export type FindingSummary = {
  findingCount: number;
  failures: number;
  warnings: number;
  rules: RuleCounts;
  severities: RuleCounts;
};

const severityRank: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function readPolicy(path: string): { defaultSeverity: Severity; failureThreshold: Severity; rules: Record<string, Severity> } {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid Gitleaks policy");
  const policy = value as Record<string, unknown>;
  if (policy.version !== 1 || !isSeverity(policy.defaultSeverity) || !isSeverity(policy.failureThreshold)) {
    throw new Error("invalid Gitleaks policy header");
  }
  if (typeof policy.rules !== "object" || policy.rules === null || Array.isArray(policy.rules)) {
    throw new Error("invalid Gitleaks policy rules");
  }
  const rules: Record<string, Severity> = {};
  for (const [rule, severity] of Object.entries(policy.rules)) {
    if (!isSeverity(severity)) throw new Error(`invalid severity for ${rule}`);
    rules[rule] = severity;
  }
  return { defaultSeverity: policy.defaultSeverity, failureThreshold: policy.failureThreshold, rules };
}

function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && Object.hasOwn(severityRank, value);
}

function readFindings(path: string): Finding[] {
  if (!existsSync(path)) return [];
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8") || "[]");
    return Array.isArray(value) ? value.filter((item): item is Finding => typeof item === "object" && item !== null) : [];
  } catch {
    return [];
  }
}

function rootVariants(root: string): string[] {
  const roots = new Set([resolve(root)]);
  try {
    roots.add(realpathSync(root));
  } catch {}
  for (const candidate of [...roots]) {
    if (candidate.startsWith("/private/")) roots.add(candidate.slice(8));
    else if (candidate.startsWith("/var/")) roots.add(`/private${candidate}`);
  }
  return [...roots];
}

function safeRelative(root: string, locator: string): string {
  if (!locator || !isAbsolute(locator)) return "unknown";
  for (const candidate of rootVariants(root)) {
    const path = relative(candidate, locator);
    if (path && path !== ".." && !path.startsWith("../") && !path.startsWith("/")) return path;
  }
  return "unknown";
}

export function sqlitePageStats(path: string): [number, number, number] {
  const header = Buffer.alloc(100);
  const descriptor = openSync(path, "r");
  let bytesRead: number;
  try {
    bytesRead = readSync(descriptor, header, 0, header.length, 0);
  } finally {
    closeSync(descriptor);
  }
  const fileSize = statSync(path).size;
  if (bytesRead < 100 || header.subarray(0, 16).toString("binary") !== "SQLite format 3\0") throw new Error("invalid SQLite header");
  let pageSize = header.readUInt16BE(16);
  if (pageSize === 1) pageSize = 65_536;
  if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) throw new Error("invalid SQLite page size");
  const changeCounter = header.readUInt32BE(24);
  const pageCount = header.readUInt32BE(28);
  const freelistCount = header.readUInt32BE(36);
  const validFor = header.readUInt32BE(92);
  const version = header.readUInt32BE(96);
  const expectedSize = pageCount * pageSize;
  if (
    changeCounter !== validFor ||
    version < 3_007_000 ||
    pageCount === 0 ||
    freelistCount > pageCount ||
    expectedSize > fileSize ||
    fileSize > expectedSize + pageSize
  ) {
    throw new Error("inconsistent SQLite header");
  }
  return [pageSize, pageCount, freelistCount];
}

export function findingLocators(scanRoot: string, reportPath: string): string[] {
  return readFindings(reportPath).map((finding) => {
    const rule = String(finding.RuleID || "unknown");
    const locator = String(finding.SymlinkFile || finding.File || "");
    return `${rule}\t${safeRelative(scanRoot, locator)}`;
  });
}

function readRuleCounts(existingJson: string): RuleCounts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(existingJson || "{}");
  } catch {
    throw new Error("invalid persisted count map");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid persisted count map");
  }
  const counts: RuleCounts = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`invalid count for ${key}`);
    }
    counts[key] = value;
  }
  return counts;
}

export function summarizeFindings(existingRulesJson: string, existingSeveritiesJson: string, reportPath: string, policyPath: string): FindingSummary {
  const policy = readPolicy(policyPath);
  const findings = readFindings(reportPath);
  const rules = readRuleCounts(existingRulesJson);
  const severities = readRuleCounts(existingSeveritiesJson);
  let failures = 0;
  let warnings = 0;
  for (const finding of findings) {
    const rule = String(finding.RuleID || "unknown");
    const severity = policy.rules[rule] ?? policy.defaultSeverity;
    rules[rule] = (rules[rule] ?? 0) + 1;
    severities[severity] = (severities[severity] ?? 0) + 1;
    if (severityRank[severity] >= severityRank[policy.failureThreshold]) failures += 1;
    else warnings += 1;
  }
  return {
    findingCount: findings.length,
    failures,
    warnings,
    rules: Object.fromEntries(Object.entries(rules).sort(([left], [right]) => left.localeCompare(right))),
    severities: Object.fromEntries(
      Object.keys(severityRank).flatMap((severity) => severities[severity] === undefined ? [] : [[severity, severities[severity]]]),
    ),
  };
}

function usage(): never {
  process.stderr.write("Usage: scripts/audit/data.ts sqlite-stats PATH | gitleaks-locators ROOT REPORT | gitleaks-summary POLICY RULE_COUNTS SEVERITY_COUNTS REPORT\n");
  process.exit(2);
}

function main(args: string[]): void {
  const [command, ...values] = args;
  if (command === "sqlite-stats" && values.length === 1) process.stdout.write(`${sqlitePageStats(values[0]).join(" ")}\n`);
  else if (command === "gitleaks-locators" && values.length === 2) {
    const locators = findingLocators(values[0], values[1]);
    if (locators.length > 0) process.stdout.write(`${locators.join("\n")}\n`);
  }
  else if (command === "gitleaks-summary" && values.length === 4) {
    const result = summarizeFindings(values[1], values[2], values[3], values[0]);
    process.stdout.write(`${result.findingCount} ${result.failures} ${result.warnings} ${JSON.stringify(result.rules)} ${JSON.stringify(result.severities)}\n`);
  }
  else usage();
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
