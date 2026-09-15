import { readFileSync, realpathSync } from "node:fs";
import { Schema } from "effect";
import { isAbsolute, relative, resolve } from "node:path";

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

function readPolicy(path: string): {
  defaultSeverity: Severity;
  failureThreshold: Severity;
  rules: Record<string, Severity>;
} {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid Gitleaks policy");
  const policy = value as Record<string, unknown>;
  if (
    policy.version !== 1 ||
    !isSeverity(policy.defaultSeverity) ||
    !isSeverity(policy.failureThreshold)
  ) {
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
  return {
    defaultSeverity: policy.defaultSeverity,
    failureThreshold: policy.failureThreshold,
    rules,
  };
}

function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && Object.hasOwn(severityRank, value);
}

function readFindings(path: string): readonly Finding[] {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (Schema.is(Schema.Array(Schema.Record(Schema.String, Schema.Unknown)))(value)) return value;
  } catch {
    throw new Error("Gitleaks report is missing or invalid");
  }
  throw new Error("Gitleaks report is missing or invalid");
}

function rootVariants(root: string): string[] {
  const roots = new Set([resolve(root)]);
  try {
    roots.add(realpathSync(root));
  } catch {}
  for (const candidate of roots) {
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

export function findingLocators(scanRoot: string, reportPath: string): string[] {
  return readFindings(reportPath).map((finding) => {
    const rule = Schema.is(Schema.NonEmptyString)(finding.RuleID) ? finding.RuleID : "unknown";
    const locator = Schema.is(Schema.NonEmptyString)(finding.SymlinkFile)
      ? finding.SymlinkFile
      : Schema.is(Schema.String)(finding.File)
        ? finding.File
        : "";
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

export function summarizeFindings(
  existingRulesJson: string,
  existingSeveritiesJson: string,
  reportPath: string,
  policyPath: string,
): FindingSummary {
  const policy = readPolicy(policyPath);
  const findings = readFindings(reportPath);
  const rules = readRuleCounts(existingRulesJson);
  const severities = readRuleCounts(existingSeveritiesJson);
  let failures = 0;
  let warnings = 0;
  for (const finding of findings) {
    const rule = Schema.is(Schema.NonEmptyString)(finding.RuleID) ? finding.RuleID : "unknown";
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
    rules: Object.fromEntries(
      Object.entries(rules).sort(([left], [right]) => left.localeCompare(right)),
    ),
    severities: Object.fromEntries(
      Object.keys(severityRank).flatMap((severity) =>
        severities[severity] === undefined ? [] : [[severity, severities[severity]]],
      ),
    ),
  };
}
