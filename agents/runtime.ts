import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

type StreamMode = "capture" | "ignore" | "inherit";

type RunOptions = {
  stdout?: StreamMode;
  stderr?: StreamMode;
};

export type Writer = {
  write(message: string): unknown;
};

export type Runtime = {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  repoDir?: string;
  stdout: Writer;
  stderr: Writer;
  commandExists(command: string): boolean;
  run(command: string, args: readonly string[], options?: RunOptions): CommandResult;
};

function stream(mode: StreamMode | undefined): "ignore" | "inherit" | "pipe" {
  return mode === "capture" ? "pipe" : (mode ?? "inherit");
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableNames(command: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") {
    return [command];
  }

  const extensions = (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";");
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

export function createRuntime(env: NodeJS.ProcessEnv = process.env): Runtime {
  return {
    env,
    platform: process.platform,
    stdout: process.stdout,
    stderr: process.stderr,
    commandExists(command) {
      const names = executableNames(command, env);
      return (env.PATH ?? "")
        .split(delimiter)
        .filter((directory) => directory.length > 0)
        .some((directory) => names.some((name) => isExecutable(join(directory, name))));
    },
    run(command, args, options = {}) {
      const result = spawnSync(command, args, {
        encoding: "utf8",
        env,
        stdio: ["ignore", stream(options.stdout), stream(options.stderr)],
      });

      return {
        status: result.status ?? 127,
        stdout: typeof result.stdout === "string" ? result.stdout : "",
        stderr: result.error?.message ?? (typeof result.stderr === "string" ? result.stderr : ""),
      };
    },
  };
}

export function writeLine(writer: Writer, message: string): void {
  writer.write(`${message}\n`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resolveProfileName(
  runtime: Runtime,
  scriptDir: string,
  expectedProfile: string | undefined,
): string {
  const args = expectedProfile === undefined ? [] : ["--expected", expectedProfile];
  const result = runtime.run(join(scriptDir, "resolve-profile.ts"), args, {
    stdout: "capture",
    stderr: "capture",
  });
  if (result.status !== 0) {
    const detail = result.stderr.trim();
    throw new Error(`Profile resolution failed${detail ? `: ${detail}` : ""}`);
  }

  return result.stdout.trim();
}
