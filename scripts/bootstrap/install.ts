#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option } from "effect";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../lib/command.ts";
import { CliFailure, fail, runMain } from "../lib/program.ts";
import { profileModelFile, resolveProfile } from "../profiles/current.ts";
import { readProfileModelEffect, requireProfile } from "../profiles/model.ts";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = process.env.DOTFILES_INSTALL_REPO_ROOT || sourceRoot;
const usage = `Usage:
  scripts/bootstrap/install.ts --profile personal-workstation|personal-devbox|workstation|devbox|assistant
  scripts/bootstrap/install.ts --print-steps --profile PROFILE

Applies per-user dotfiles and runs only the setup steps owned by the selected
role. An existing ~/.config/dotfiles/profile is used when --profile is omitted.`;

const execute = Effect.fn("executeInstallCommand")(function*(label: string, command: string, args: readonly string[]) {
  const runner = yield* CommandRunner;
  const result = yield* runner.run(command, args, { cwd: repoRoot, stdin: "inherit", output: "inherit" }).pipe(
    Effect.mapError((error) => new CliFailure({ exitCode: 1, message: `${label}: ${error.message}` })),
  );
  if (result.status !== 0) return yield* fail(`${label} exited ${result.status}`, result.status);
});

const runStep = Effect.fn("runInstallStep")(function*(step: string, profile: string) {
  const bootstrap = (name: string) => resolve(repoRoot, "scripts/bootstrap", name);
  switch (step) {
    case "apply-dotfiles":
      return yield* execute(step, bootstrap("apply-dotfiles.ts"), ["--profile", profile]);
    case "install-gh-app-auth":
      return yield* execute(step, bootstrap("install-gh-app-auth.ts"), []);
    case "install-cursor-agent":
      return yield* execute(step, bootstrap("install-cursor-agent.ts"), []);
    case "trust-agent-worktrees":
      return yield* execute(step, bootstrap("trust-agent-worktrees.ts"), []);
    case "install-gh-extensions":
      return yield* execute(step, bootstrap("install-gh-extensions.ts"), []);
    case "install-runtimes":
      return yield* execute(step, "mise", ["install"]);
    case "install-repository-dependencies":
      return yield* execute(step, "mise", ["exec", "--", "corepack", "pnpm", "--dir", repoRoot, "install", "--frozen-lockfile"]);
    case "configure-codex":
      return yield* execute(step, bootstrap("configure-codex.ts"), []);
    case "configure-llm-gateway": {
      const fs = yield* FileSystem.FileSystem;
      const path = process.env.LLM_GATEWAY_CONFIG || join(process.env.HOME || "", ".config/dotfiles/llm-gateway.json");
      const link = yield* fs.readLink(path).pipe(Effect.option);
      const info = yield* fs.stat(path).pipe(Effect.option);
      if (Option.isSome(link) || Option.isNone(info) || info.value.type !== "File" || (info.value.mode & 0o077) !== 0) {
        return yield* fail(`personal setup requires an owner-only LLM gateway config: ${path}`);
      }
      yield* execute(step, bootstrap("configure-llm-gateway.ts"), []);
      return yield* execute(`${step} retire auth`, bootstrap("configure-llm-gateway.ts"), ["--retire-auth"]);
    }
    case "configure-bifrost-clients":
      yield* execute(step, bootstrap("configure-bifrost-clients.ts"), []);
      return yield* execute(`${step} check`, bootstrap("configure-bifrost-clients.ts"), ["--check"]);
    case "sync-agents":
      for (const name of ["sync.ts", "plugins.ts", "mcps.ts"]) {
        yield* execute(`${step} ${name}`, resolve(repoRoot, "scripts/agents", name), ["--profile", profile]);
      }
      return;
    default:
      return yield* fail(`unsupported install step: ${step}`, 2);
  }
});

const program = Effect.gen(function*() {
  let profileInput: string | undefined;
  let printSteps = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--profile") {
      const value = args[index + 1];
      if (!value || profileInput !== undefined) {
        yield* Console.error(usage);
        return yield* fail("invalid --profile", 2);
      }
      profileInput = value;
      index += 1;
    } else if (argument === "--print-steps") {
      printSteps = true;
    } else if (argument === "-h" || argument === "--help") {
      yield* Console.log(usage);
      return;
    } else {
      yield* Console.error(usage);
      return yield* fail(`unsupported argument ${argument}`, 2);
    }
  }

  const profile = yield* resolveProfile(profileInput).pipe(
    Effect.mapError(() => new CliFailure({ exitCode: 2, message: "a supported profile is required: personal-workstation, personal-devbox, workstation, devbox, or assistant" })),
  );
  const modelPath = repoRoot === sourceRoot
    ? profileModelFile()
    : resolve(repoRoot, "chezmoi/.chezmoidata/profiles.json");
  const model = yield* readProfileModelEffect(modelPath).pipe(
    Effect.mapError((error) => new CliFailure({ exitCode: 2, message: error.message })),
  );
  const steps = requireProfile(model, profile).installSteps;
  if (printSteps) {
    yield* Console.log(steps.join("\n"));
    return;
  }
  yield* Effect.forEach(steps, (step) => runStep(step, profile));
}).pipe(
  Effect.provide(CommandRunner.layer),
  Effect.provide(NodeServices.layer),
);

runMain(program);
