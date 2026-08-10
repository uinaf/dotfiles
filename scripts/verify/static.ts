#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const agentlessSigner = resolve(
  repoRoot,
  "chezmoi/private_dot_local/private_libexec/private_dotfiles/private_executable_git-ssh-sign-agentless",
);
const ghosttyConfig = resolve(
  repoRoot,
  "chezmoi/private_Library/private_Application Support/com.mitchellh.ghostty/private_config",
);

function fail(message: string): never {
  process.stderr.write(`FAILED: ${message}\n`);
  process.exit(1);
}

function filesBelow(root: string, accept: (path: string) => boolean): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...filesBelow(path, accept));
    } else if (entry.isFile() && accept(path)) {
      files.push(path);
    }
  }
  return files;
}

function run(command: string, args: string[], label: string): void {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    fail(`${label}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    fail(`${label} exited ${result.status ?? 1}`);
  }
}

const shellFiles = [
  resolve(repoRoot, "dotfiles"),
  ...filesBelow(resolve(repoRoot, "scripts"), (path) => path.endsWith(".sh")),
  agentlessSigner,
];
run("bash", ["-n", ...shellFiles], "shell syntax");
run("shellcheck", shellFiles, "ShellCheck");

if (existsSync(resolve(repoRoot, ".github/workflows"))) {
  run("actionlint", [], "Actionlint");
}

run("git", ["diff", "--check"], "working-tree diff hygiene");
run("git", ["diff", "--cached", "--check"], "index diff hygiene");

let ghosttyLines: string[];
try {
  ghosttyLines = readFileSync(ghosttyConfig, "utf8").split(/\r?\n/);
} catch (error) {
  fail(`cannot read managed Ghostty config: ${error instanceof Error ? error.message : String(error)}`);
}
if (!ghosttyLines.includes("shell-integration-features = ssh-env,ssh-terminfo")) {
  fail("managed Ghostty config does not enable SSH environment and terminfo integration");
}

const agentsPath = resolve(repoRoot, "AGENTS.md");
const claudePath = resolve(repoRoot, "CLAUDE.md");
if (!existsSync(agentsPath)) {
  fail("missing AGENTS.md");
}
if (!existsSync(claudePath) || !lstatSync(claudePath).isSymbolicLink() || readlinkSync(claudePath) !== "AGENTS.md") {
  fail("CLAUDE.md must be a symlink to AGENTS.md");
}

process.stdout.write("ok static repository checks\n");
