#!/usr/bin/env node

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

type Mode = "enable" | "disable";

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

export function updateChromeState(path: string, mode: Mode, flagName: string, flagValue: string): void {
  let data: Record<string, unknown> = {};
  try {
    const source = readFileSync(path, "utf8");
    try {
      data = object(JSON.parse(source), `${path} contents`);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`${path} is not valid JSON: ${error.message}`);
      throw error;
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  const browser = data.browser === undefined ? {} : object(data.browser, '"browser"');
  const current = browser.enabled_labs_experiments ?? [];
  if (!Array.isArray(current)) throw new Error('"browser.enabled_labs_experiments" must be a JSON array');
  const prefix = `${flagName}@`;
  const experiments = current.filter((item) => typeof item !== "string" || (item !== flagName && !item.startsWith(prefix)));
  if (mode === "enable") experiments.push(flagValue);
  browser.enabled_labs_experiments = experiments;
  data.browser = browser;

  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  let fileMode = 0o600;
  try {
    fileMode = statSync(path).mode & 0o7777;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const temporaryDirectory = mkdtempSync(join(directory, ".chrome-state."));
  const temporaryPath = join(temporaryDirectory, "Local State");
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(data)}\n`, { mode: fileMode });
    chmodSync(temporaryPath, fileMode);
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

function main(args: string[]): void {
  const [path, mode, flagName, flagValue] = args;
  if (args.length !== 4 || (mode !== "enable" && mode !== "disable")) {
    process.stderr.write("Usage: scripts/bootstrap/chrome-state.ts PATH <enable|disable> FLAG VALUE\n");
    process.exitCode = 2;
    return;
  }
  updateChromeState(path, mode, flagName, flagValue);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
