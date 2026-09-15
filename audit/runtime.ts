import { spawnSync } from "node:child_process";
import { accessSync } from "node:fs";

export type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type CommandOptions = { output?: "capture" | "discard"; input?: "inherit" | "pipe" };
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: CommandOptions,
) => CommandResult;

export function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): CommandResult {
  const output = options.output === "discard" ? "ignore" : "pipe";
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    stdio: [options.input ?? "inherit", output, output],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
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

export function runPolicyCommand(command: string, args: readonly string[]): CommandResult {
  return runCommand(command, args, { input: "pipe" });
}
