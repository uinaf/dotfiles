import { spawnSync } from "node:child_process";
import { accessSync } from "node:fs";

export type AuditFormat = "text" | "json";
export type FindingSeverity = "ok" | "warn" | "fail";

export type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type CommandOptions = { output?: "capture" | "discard" };
export type CommandRunner = (command: string, args: readonly string[], options?: CommandOptions) => CommandResult;

export function runCommand(command: string, args: readonly string[], options: CommandOptions = {}): CommandResult {
  const output = options.output === "discard" ? "ignore" : "pipe";
  const result = spawnSync(command, [...args], { encoding: "utf8", stdio: ["inherit", output, output] });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

export function canAccess(path: string, mode: number): boolean {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

export type AuditDependencies = {
  command?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
};

type Finding = { severity: FindingSeverity; message: string };

export type AuditSummary<Name extends string, Fields extends object> = AuditBaseSummary & { audit: Name } & Fields;

export class AuditReport {
  readonly findings: Finding[] = [];
  readonly format: AuditFormat;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;

  constructor(
    format: AuditFormat,
    stdout: (value: string) => void,
    stderr: (value: string) => void,
  ) {
    this.format = format;
    this.stdout = stdout;
    this.stderr = stderr;
  }

  section(title: string): void {
    if (this.format === "text") this.stdout(`\n## ${title}\n`);
  }

  finding(severity: FindingSeverity, message: string): void {
    this.findings.push({ severity, message });
    if (this.format === "json") return;
    const line = `${severity === "fail" ? "FAILED:" : severity} ${message}\n`;
    (severity === "ok" ? this.stdout : this.stderr)(line);
  }

  ok(message: string): void {
    this.finding("ok", message);
  }

  warn(message: string): void {
    this.finding("warn", message);
  }

  fail(message: string): void {
    this.finding("fail", message);
  }

  output(result: CommandResult): void {
    if (this.format !== "text") return;
    if (result.stdout) this.stdout(result.stdout);
    if (result.stderr) this.stderr(result.stderr);
  }

  finish<Name extends string, Fields extends object>(audit: Name, label: string, fields: Fields): { status: number; summary: AuditSummary<Name, Fields> } {
    const failed = this.findings.filter(({ severity }) => severity === "fail").length;
    const warnings = this.findings.filter(({ severity }) => severity === "warn").length;
    const status: "pass" | "warn" | "fail" = failed > 0 ? "fail" : warnings > 0 ? "warn" : "pass";
    const summary = {
      audit,
      status,
      failed,
      warnings,
      ...fields,
    };
    if (this.format === "json") this.stdout(`${JSON.stringify(summary)}\n`);
    else this.stdout(`\n${label}: ${failed} failed, ${warnings} warnings\n`);
    return { status: failed > 0 ? 1 : 0, summary };
  }
}

export type AuditBaseSummary = {
  audit: string;
  status: "pass" | "warn" | "fail";
  failed: number;
  warnings: number;
};
