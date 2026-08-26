#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, DateTime, Effect, FileSystem, Option, Schema } from "effect";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { refreshAgentRules } from "../agents/rules.ts";
import { CommandRunner } from "../lib/command.ts";
import { CliFailure, fail, runMain } from "../lib/program.ts";
import { resolveProfile } from "../profiles/current.ts";
import { readProfileModelEffect, requireProfile } from "../profiles/model.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceDir = join(repoRoot, "chezmoi");
const home = process.env.HOME || "";
const configDir = join(home, ".config/dotfiles");
const agentRulesPath = join(process.env.XDG_STATE_HOME || join(home, ".local/state"), "dotfiles/agent-rules.md");
const usage = `Usage:
  scripts/bootstrap/apply-dotfiles.ts [--profile PROFILE] [--dry-run] [--verbose]

Applies the repo-local chezmoi source state for personal-workstation, personal-devbox,
workstation, devbox, or assistant to $HOME. When --profile is omitted, the stored profile is used,
followed by DOTFILES_PROFILE for first-time setup.`;

const Arguments = Schema.Struct({
  profile: Schema.optional(Schema.String),
  dryRun: Schema.Boolean,
  verbose: Schema.Boolean,
});
type Arguments = typeof Arguments.Type;

const parseArguments = Effect.fn("parseApplyDotfilesArguments")(function*(args: readonly string[]) {
  const parsed: { profile?: string; dryRun: boolean; verbose: boolean } = { dryRun: false, verbose: false };
  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case "--profile": {
        const profile = args[index + 1];
        if (!profile || parsed.profile !== undefined) return yield* fail("invalid --profile", 2);
        parsed.profile = profile;
        index += 1;
        break;
      }
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--verbose":
        parsed.verbose = true;
        break;
      default:
        return yield* fail(`unsupported argument ${args[index]}`, 2);
    }
  }
  return yield* Schema.decodeUnknownEffect(Arguments)(parsed).pipe(
    Effect.mapError((error) => new CliFailure({ exitCode: 2, message: error.message })),
  );
});

type ChezmoiContext = {
  readonly baseArgs: readonly string[];
  readonly dryRun: boolean;
};

const runCommand = Effect.fn("runApplyDotfilesCommand")(function*(
  command: string,
  args: readonly string[],
  output: "capture" | "inherit" = "capture",
) {
  const runner = yield* CommandRunner;
  const result = yield* runner.run(command, args, { cwd: repoRoot, stdin: "inherit", output }).pipe(
    Effect.mapError((error) => new CliFailure({ exitCode: 1, message: error.message })),
  );
  if (result.status !== 0) return yield* fail(`${command} exited ${result.status}`, result.status);
  return result;
});

const runChezmoi = Effect.fn("runChezmoi")(function*(
  context: ChezmoiContext,
  args: readonly string[],
  output: "capture" | "inherit" = "capture",
) {
  return yield* runCommand("chezmoi", [...context.baseArgs, ...args], output);
});

const matchesManagedTarget = Effect.fn("matchesManagedTarget")(function*(
  context: ChezmoiContext,
  target: string,
  expectedType: "file" | "symlink" | "remove",
) {
  const fs = yield* FileSystem.FileSystem;
  const link = yield* fs.readLink(target).pipe(Effect.option);
  const exists = yield* fs.exists(target);
  if (!exists && Option.isNone(link)) return true;
  if (expectedType === "symlink" && Option.isSome(link)) {
    const expected = yield* runChezmoi(context, ["cat", target]);
    return link.value === expected.stdout.trimEnd();
  }
  if (expectedType === "file" && exists && Option.isNone(link)) {
    const [actual, expected] = yield* Effect.all([
      fs.readFileString(target),
      runChezmoi(context, ["cat", target]).pipe(Effect.map((result) => result.stdout)),
    ]);
    return actual === expected;
  }
  return false;
});

const backupPath = Effect.fn("backupPath")(function*(
  context: ChezmoiContext,
  target: string,
  expectedType: "file" | "symlink",
) {
  const matches = yield* matchesManagedTarget(context, target, expectedType);
  if (matches) return;
  const fs = yield* FileSystem.FileSystem;
  const now = yield* DateTime.now;
  const timestamp = DateTime.formatIso(now).replaceAll(/\D/g, "").slice(0, 14);
  const backup = `${target}.backup.${timestamp}`;
  if (context.dryRun) {
    yield* Console.log(`would back up ${target} -> ${backup}`);
    return;
  }
  const link = yield* fs.readLink(target).pipe(Effect.option);
  if (expectedType === "file" && Option.isNone(link)) {
    yield* fs.copy(target, backup, { preserveTimestamps: true });
  } else {
    yield* fs.rename(target, backup);
  }
  yield* Console.log(`backed up ${target} -> ${backup}`);
});

const replaceAgentPath = Effect.fn("replaceAgentPath")(function*(
  context: ChezmoiContext,
  target: string,
  expectedType: "file" | "symlink" | "remove",
) {
  const matches = yield* matchesManagedTarget(context, target, expectedType);
  if (matches) return;
  if (context.dryRun) {
    yield* Console.log(`would replace generated agent rules at ${target}`);
    return;
  }
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(target, { force: true });
  yield* Console.log(`removed conflicting generated agent rules at ${target}`);
});

const managedTargets = Effect.fn("managedTargets")(function*(context: ChezmoiContext, include: "files" | "symlinks") {
  const result = yield* runChezmoi(context, ["managed", `--include=${include}`, "--path-style", "absolute"]);
  return result.stdout.split("\n").filter((target) => target.length > 0);
});

const validateLocalAgentRules = Effect.fn("validateLocalAgentRules")(function*() {
  const fs = yield* FileSystem.FileSystem;
  for (const path of [join(configDir, "agents.start.md"), join(configDir, "agents.end.md")]) {
    const link = yield* fs.readLink(path).pipe(Effect.option);
    const exists = yield* fs.exists(path);
    if (Option.isSome(link) && !exists) return yield* fail(`local agent rules link is broken: ${path}`);
    if (!exists) continue;
    const info = yield* fs.stat(path).pipe(
      Effect.mapError(() => new CliFailure({ exitCode: 1, message: `cannot inspect local agent rules: ${path}` })),
    );
    if (info.type !== "File") return yield* fail(`local agent rules must resolve to a regular file: ${path}`);
    if (Option.getOrUndefined(info.uid) !== process.getuid?.()) {
      return yield* fail(`local agent rules must be owned by the current user: ${path}`);
    }
    if ((info.mode & 0o077) !== 0) {
      return yield* fail(`local agent rules must not grant group or other access: ${path}`);
    }
  }
});

const backupPreexistingTargets = Effect.fn("backupPreexistingTargets")(function*(
  context: ChezmoiContext,
  developer: boolean,
) {
  if (developer) yield* replaceAgentPath(context, join(home, ".agents/AGENTS.md"), "remove");
  for (const target of yield* managedTargets(context, "files")) {
    if (target === join(home, "AGENTS.md")) {
      yield* replaceAgentPath(context, target, "file");
    } else {
      yield* backupPath(context, target, "file");
    }
  }
  for (const target of yield* managedTargets(context, "symlinks")) {
    if (target === join(home, ".claude/CLAUDE.md") || target === join(home, ".codex/AGENTS.md")) {
      yield* replaceAgentPath(context, target, "symlink");
    } else {
      yield* backupPath(context, target, "symlink");
    }
  }
});

const program = Effect.gen(function*() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 1 && (rawArgs[0] === "-h" || rawArgs[0] === "--help")) {
    yield* Console.log(usage);
    return;
  }
  const args = yield* parseArguments(rawArgs).pipe(
    Effect.tapError(() => Console.error(usage)),
  );
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(sourceDir))) return yield* fail(`missing chezmoi source directory: ${sourceDir}`);
  if (!home) return yield* fail("HOME is required");
  const profile = yield* resolveProfile(args.profile).pipe(
    Effect.mapError(() => new CliFailure({
      exitCode: 2,
      message: "a supported profile is required: personal-workstation, personal-devbox, workstation, devbox, or assistant",
    })),
  );
  const model = yield* readProfileModelEffect(join(sourceDir, ".chezmoidata/profiles.json"));
  const profileConfig = yield* Effect.try({
    try: () => requireProfile(model, profile),
    catch: () => new CliFailure({ exitCode: 2, message: `unsupported profile: ${profile}` }),
  });
  const configLink = yield* fs.readLink(configDir).pipe(Effect.option);
  if (Option.isSome(configLink)) return yield* fail(`canonical config directory must not be a symlink: ${configDir}`);
  const configExists = yield* fs.exists(configDir);
  if (configExists && (yield* fs.stat(configDir)).type !== "Directory") {
    return yield* fail(`canonical config path must be a directory: ${configDir}`);
  }
  const context: ChezmoiContext = {
    baseArgs: [
      "--source",
      sourceDir,
      "--destination",
      home,
      "--override-data",
      JSON.stringify({ agentRulesPath, dotfilesProfile: profile }),
    ],
    dryRun: args.dryRun,
  };
  if (profileConfig.capabilities.developer) {
    yield* validateLocalAgentRules();
    yield* refreshAgentRules(repoRoot, agentRulesPath, {
      offline: process.env.DOTFILES_AGENT_RULES_OFFLINE === "1",
    });
  }
  yield* backupPreexistingTargets(context, profileConfig.capabilities.developer);
  const applyArgs = [...context.baseArgs, "--force", "apply"];
  if (args.dryRun) applyArgs.push("--dry-run");
  if (args.verbose) applyArgs.push("--verbose");
  yield* runCommand("chezmoi", applyArgs, "inherit");
  yield* Console.log(`dotfiles ${args.dryRun ? "previewed" : "applied"} for ${profile} with chezmoi source ${sourceDir}`);
}).pipe(
  Effect.provide(CommandRunner.layer),
  Effect.provide(NodeServices.layer),
);

runMain(program);
