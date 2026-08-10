#!/usr/bin/env node

import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Finding = Record<string, unknown>;
type RuleCounts = Record<string, number>;

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
  const roots = new Set([resolve(root), realpathSync(root)]);
  for (const candidate of [...roots]) {
    if (candidate.startsWith("/private/")) roots.add(candidate.slice(8));
    else if (candidate.startsWith("/var/")) roots.add(`/private${candidate}`);
  }
  return [...roots];
}

function safeRelative(root: string, locator: string): string {
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

export function mergeRuleCounts(existingJson: string, reportPath: string): RuleCounts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(existingJson || "{}");
  } catch {
    parsed = {};
  }
  const counts: RuleCounts = {};
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed)) {
      if (!Number.isInteger(value)) throw new Error(`invalid count for ${key}`);
      counts[key] = value as number;
    }
  }
  for (const finding of readFindings(reportPath)) {
    const rule = String(finding.RuleID || "unknown");
    counts[rule] = (counts[rule] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function usage(): never {
  process.stderr.write("Usage: scripts/audit/data.ts sqlite-stats PATH | gitleaks-locators ROOT REPORT | gitleaks-merge COUNTS REPORT | gitleaks-count REPORT\n");
  process.exit(2);
}

function main(args: string[]): void {
  const [command, ...values] = args;
  if (command === "sqlite-stats" && values.length === 1) process.stdout.write(`${sqlitePageStats(values[0]).join(" ")}\n`);
  else if (command === "gitleaks-locators" && values.length === 2) process.stdout.write(`${findingLocators(values[0], values[1]).join("\n")}\n`);
  else if (command === "gitleaks-merge" && values.length === 2) process.stdout.write(`${JSON.stringify(mergeRuleCounts(values[0], values[1]))}\n`);
  else if (command === "gitleaks-count" && values.length === 1) process.stdout.write(`${readFindings(values[0]).length}\n`);
  else usage();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
