#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option } from "effect";
import { join } from "node:path";
import { CommandRunner } from "../lib/command.ts";
import { CliFailure, fail, runMain } from "../lib/program.ts";
import { profileModelFile, resolveProfile } from "../profiles/current.ts";
import { readProfileModelEffect, requireProfile } from "../profiles/model.ts";

const runGit = Effect.fn("runWorkloadGitCheck")(function*(args: readonly string[], failure: string) {
  const runner = yield* CommandRunner;
  const result = yield* runner.run("git", args).pipe(
    Effect.mapError((error) => new CliFailure({ exitCode: 1, message: error.message })),
  );
  if (result.status !== 0) return yield* fail(failure);
  return result.stdout.trimEnd();
});

const program = Effect.gen(function*() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--profile") return yield* fail("--profile requires assistant", 2);
  const profile = yield* resolveProfile(args[1]).pipe(
    Effect.mapError(() => new CliFailure({ exitCode: 1, message: "a persisted assistant profile is required" })),
  );
  const model = yield* readProfileModelEffect(profileModelFile());
  const config = requireProfile(model, profile);
  if (!config.capabilities.workload) return yield* fail(`workload Git verification does not support profile: ${profile}`);
  const home = process.env.HOME || "";
  const trackedConfig = join(home, ".gitconfig");
  const workloadConfig = join(home, ".gitconfig.local");
  const fs = yield* FileSystem.FileSystem;
  for (const [path, label] of [[trackedConfig, `${profile} Git base config`], [workloadConfig, "workload Git identity"]] as const) {
    const info = yield* fs.stat(path).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") return yield* fail(`missing ${label}; reapply or configure the ${profile} profile`);
  }
  const workloadInfo = yield* fs.stat(workloadConfig);
  if ((workloadInfo.mode & 0o777) !== 0o600) return yield* fail(`${profile} workload Git config must have mode 600`);
  const expectedIncludes = ["~/.gitconfig.local"];
  if (config.capabilities.githubAppAuth) expectedIncludes.push("~/.config/dotfiles/github-app.gitconfig");
  const tracked = yield* runGit(["config", "--file", trackedConfig, "--no-includes", "--list"], `${profile} Git base config cannot be parsed`);
  const trackedAllowed = new Set(["core.ignorecase", "include.path"]);
  for (const entry of tracked.split("\n").filter(Boolean)) {
    const key = entry.split("=", 1)[0] || "";
    if (!trackedAllowed.has(key)) return yield* fail(`${profile} Git base config contains unsupported key: ${key}`);
  }
  const includes = yield* runGit(
    ["config", "--file", trackedConfig, "--no-includes", "--get-all", "include.path"],
    `${profile} Git base config does not include ~/.gitconfig.local`,
  );
  if (includes !== expectedIncludes.join("\n")) return yield* fail(`${profile} Git base config has unsupported includes`);
  const workload = yield* runGit(["config", "--file", workloadConfig, "--no-includes", "--list"], `${profile} workload Git config cannot be parsed`);
  const workloadAllowed = new Set(["user.name", "user.email", "commit.gpgsign", "tag.gpgsign", "dotfiles.identity"]);
  for (const entry of workload.split("\n").filter(Boolean)) {
    const key = entry.split("=", 1)[0] || "";
    if (!workloadAllowed.has(key)) return yield* fail(`${profile} workload Git config contains unsupported key: ${key}`);
  }
  for (const [key, expected, message] of [
    ["user.name", undefined, `${profile} workload Git user.name is empty`],
    ["user.email", undefined, `${profile} workload Git user.email is empty`],
    ["commit.gpgsign", "false", `${profile} workload commits must not use a persisted signing key`],
    ["tag.gpgsign", "false", `${profile} workload tags must not use a persisted signing key`],
    ["dotfiles.identity", "workload", `${profile} Git identity is not marked as workload-owned`],
  ] as const) {
    const value = yield* runGit(["config", "--file", workloadConfig, "--get", key], message);
    if (expected === undefined ? !value : value !== expected) return yield* fail(message);
  }
  yield* Console.log(`ok ${profile} Git base and workload identity match the expected profile contract`);
}).pipe(
  Effect.provide(CommandRunner.layer),
  Effect.provide(NodeServices.layer),
);

runMain(program);
