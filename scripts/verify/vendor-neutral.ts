#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../lib/command.ts";
import { fail, runMain } from "../lib/program.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function containsAny(content: string, values: readonly string[]): boolean {
  return values.some((value) => content.includes(value));
}

function allowed(file: string, content: string): boolean {
  switch (file) {
    case "AGENTS.md":
      return content.includes("Do not add `uinaf` or another owner");
    case "Brewfile.developer":
    case "Brewfile.personal":
    case "Brewfile.devbox":
    case "CONTRIBUTING.md":
    case "LICENSE":
    case "README.md":
    case "SECURITY.md":
    case "docs/bootstrap.md":
    case "docs/profiles.md":
      return containsAny(content, [
        "uinaf/dotfiles",
        "uinaf/tap",
        "github.com/uinaf/sops-vault-template",
        "https://uinaf.dev/og/banner/dotfiles.png",
        "dev@uinaf.dev",
        "Copyright (c) 2026 uinaf",
      ]);
    case "docs/identities.md":
      return content.includes("github.com/uinaf/sops-vault-template");
    case "docs/agents.md":
      return containsAny(content, ["github.com/uinaf/agent-skills", "github.com/uinaf/attach", "github.com/uinaf/design", "uinaf-design"]);
    case "scripts/agents/skills/developer.json":
    case "scripts/agents/skills/workstation.json":
    case "scripts/agents/skills/devbox.json":
    case "scripts/agents/skills/personal.json":
      return containsAny(content, [
        '"name": "uinaf-design"',
        '"name": "uinaf-radar"',
        '"source": "uinaf/agent-skills"',
        '"source": "uinaf/attach"',
        '"source": "uinaf/design"',
        '"source": "https://cdn.uinaf.dev/skills/ui"',
      ]);
    case "scripts/agents/plugins/developer.json":
    case "scripts/agents/plugins/workstation.json":
    case "scripts/agents/plugins/devbox.json":
    case "scripts/agents/plugins/personal.json":
    case "scripts/agents/plugins.test.ts":
      return content.includes("uinaf/ffss");
    case "scripts/agents/mcps/developer.json":
    case "scripts/agents/mcps/workstation.json":
    case "scripts/agents/mcps/devbox.json":
    case "scripts/agents/mcps/personal.json":
    case "scripts/agents/mcps.test.ts":
      return containsAny(content, ["uinaf-executor", "uinaf_executor"]);
    case "scripts/agents/sync.test.ts":
      return containsAny(content, ["uinaf/agents", "uinaf/skills", "uinaf/agent-skills", "uinaf/attach", "uinaf/design", "uinaf-design"]);
    case "scripts/verify/profiles.ts":
      return content.includes("uinaf/tap");
    default:
      return false;
  }
}

const program = Effect.gen(function*() {
  const runner = yield* CommandRunner;
  const contentScan = yield* runner.run("git", [
    "-C", repoRoot, "grep", "--untracked", "-n", "-i", "uinaf", "--", ":!scripts/verify/vendor-neutral.ts",
  ]);
  if (contentScan.status !== 0 && contentScan.status !== 1) {
    return yield* fail(`vendor-neutral scan failed with git grep status ${contentScan.status}`, contentScan.status);
  }
  const pathScan = yield* runner.run("git", ["-C", repoRoot, "ls-files", "--cached", "--others", "--exclude-standard"]);
  if (pathScan.status !== 0) {
    return yield* fail(`vendor-neutral path scan failed with status ${pathScan.status}`, pathScan.status);
  }

  let unexpected = false;
  for (const path of pathScan.stdout.split(/\r?\n/).filter((value) => /uinaf/i.test(value))) {
    yield* Console.error(`unexpected vendor branding in path: ${path}`);
    unexpected = true;
  }
  for (const line of contentScan.stdout.split(/\r?\n/).filter(Boolean)) {
    const first = line.indexOf(":");
    const second = line.indexOf(":", first + 1);
    const file = line.slice(0, first);
    const lineNumber = line.slice(first + 1, second);
    const content = line.slice(second + 1);
    if (!allowed(file, content)) {
      yield* Console.error(`unexpected vendor branding: ${file}:${lineNumber}:${content}`);
      unexpected = true;
    }
  }
  if (unexpected) return yield* fail("owner-name boundary failed");
  yield* Console.log("ok owner names are limited to external coordinates");
}).pipe(
  Effect.provide(CommandRunner.layer),
  Effect.provide(NodeServices.layer),
);

runMain(program);
