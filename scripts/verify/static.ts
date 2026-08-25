#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem } from "effect";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../lib/command.ts";
import { CliFailure, fail, runMain } from "../lib/program.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const agentlessSigner = resolve(
  repoRoot,
  "chezmoi/private_dot_local/private_libexec/private_dotfiles/private_executable_git-ssh-sign-agentless",
);
const ghosttyConfig = resolve(
  repoRoot,
  "chezmoi/private_Library/private_Application Support/com.mitchellh.ghostty/private_config",
);
const blackWallpaper = resolve(repoRoot, "scripts/bootstrap/assets/black-wallpaper.plist");

const runRequired = Effect.fn("runRequired")(function*(command: string, args: readonly string[], label: string) {
  const runner = yield* CommandRunner;
  const result = yield* runner.run(command, args, { cwd: repoRoot, env: { NO_COLOR: "1" } });
  if (result.status === 0) {
    return;
  }
  yield* Effect.sync(() => {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
  });
  return yield* fail(`${label} exited ${result.status}`);
});

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const scriptsRoot = resolve(repoRoot, "scripts");
  const shellFiles = [
    resolve(repoRoot, "dotfiles"),
    ...(yield* fs.glob("**/*.sh", { root: scriptsRoot })).map((path) => resolve(scriptsRoot, path)),
    agentlessSigner,
  ];
  yield* Effect.forEach(
    shellFiles,
    (path) => runRequired("bash", ["-n", path], `shell syntax: ${path}`),
    { concurrency: "unbounded" },
  );
  yield* runRequired("shellcheck", shellFiles, "ShellCheck");

  if (yield* fs.exists(resolve(repoRoot, ".github/workflows"))) {
    yield* runRequired("actionlint", [], "Actionlint");
  }
  yield* runRequired("git", ["diff", "--check"], "working-tree diff hygiene");
  yield* runRequired("git", ["diff", "--cached", "--check"], "index diff hygiene");
  yield* runRequired("plutil", ["-lint", blackWallpaper], "desktop wallpaper plist");

  const ghosttyLines = yield* fs.readFileString(ghosttyConfig).pipe(
    Effect.map((contents) => contents.split(/\r?\n/)),
    Effect.mapError((error) => new CliFailure({ exitCode: 1, message: `cannot read managed Ghostty config: ${error}` })),
  );
  if (!ghosttyLines.includes("shell-integration-features = ssh-env,ssh-terminfo")) {
    return yield* fail("managed Ghostty config does not enable SSH environment and terminfo integration");
  }

  const agentsPath = resolve(repoRoot, "AGENTS.md");
  const claudePath = resolve(repoRoot, "CLAUDE.md");
  if (!(yield* fs.exists(agentsPath))) {
    return yield* fail("missing AGENTS.md");
  }
  const claudeTarget = yield* fs.readLink(claudePath).pipe(Effect.option);
  if (claudeTarget._tag === "None" || claudeTarget.value !== "AGENTS.md") {
    return yield* fail("CLAUDE.md must be a symlink to AGENTS.md");
  }

  yield* Console.log("ok static repository checks");
}).pipe(
  Effect.provide(CommandRunner.layer),
  Effect.provide(NodeServices.layer),
);

runMain(program);
