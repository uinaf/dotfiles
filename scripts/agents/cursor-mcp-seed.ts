#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

import { runMain } from "../lib/program.ts";

const USAGE = `Usage: ./scripts/agents/cursor-mcp-seed.ts [--from DIR] [TARGET_DIR]

Cursor Agent stores MCP OAuth tokens per project directory under
~/.cursor/projects/<slug>/mcp-auth.json, so every new checkout or worktree asks
for a fresh browser login. This copies the newest existing mcp-auth.json (or
the one for --from DIR) into the entry for TARGET_DIR (default: cwd). Tokens
are refreshed per copy and the server accepts reuse of the refresh token, so
the source entry keeps working.`;

// Mirrors Cursor's project slug: leading slash dropped, "/" -> "-", "." -> "-dot-".
export function cursorProjectSlug(directory: string): string {
  return resolve(directory).replace(/^\//, "").replace(/\./g, "-dot-").replace(/\//g, "-");
}

function newestAuthFile(projectsRoot: string): string | undefined {
  let best: { path: string; mtime: number } | undefined;
  for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(projectsRoot, entry.name, "mcp-auth.json");
    if (!existsSync(candidate)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(candidate, "utf8"));
    } catch {
      continue;
    }
    const hasTokens = typeof parsed === "object" && parsed !== null
      && Object.values(parsed).some((server) => typeof server === "object" && server !== null && "tokens" in server);
    if (!hasTokens) continue;
    const mtime = statSync(candidate).mtimeMs;
    if (best === undefined || mtime > best.mtime) best = { path: candidate, mtime };
  }
  return best?.path;
}

const program = Effect.sync(() => {
  const args = process.argv.slice(2);
  let from: string | undefined;
  let target = process.cwd();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(`${USAGE}\n`);
      return;
    }
    if (arg === "--from") {
      from = args[index + 1];
      index += 1;
      if (from === undefined) throw new Error("--from requires a directory");
    } else if (arg !== undefined && !arg.startsWith("-")) {
      target = arg;
    } else {
      throw new Error(`${USAGE}\nUnknown argument: ${arg}`);
    }
  }

  const projectsRoot = join(homedir(), ".cursor", "projects");
  const source = from === undefined
    ? newestAuthFile(projectsRoot)
    : join(projectsRoot, cursorProjectSlug(from), "mcp-auth.json");
  if (source === undefined || !existsSync(source)) {
    throw new Error("no Cursor MCP tokens to copy; run `cursor-agent mcp login <server>` in any project first");
  }
  const destinationDir = join(projectsRoot, cursorProjectSlug(target));
  const destination = join(destinationDir, "mcp-auth.json");
  if (resolve(source) === resolve(destination)) {
    process.stdout.write(`${destination} is already the source\n`);
    return;
  }
  mkdirSync(destinationDir, { recursive: true });
  copyFileSync(source, destination);
  process.stdout.write(`Seeded ${destination} from ${source}\nVerify with: cursor-agent mcp list\n`);
});

const entrypoint = process.argv[1];
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  runMain(program);
}
