#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "./lib/command.ts";
import { fail, runMain } from "./lib/program.ts";
import { readProfileModelEffect, requireProfile } from "./profiles/model.ts";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = process.env.DOTFILES_OPERATOR_REPO_ROOT || sourceRoot;
const usage = `Usage: ./dotfiles diff|apply|check PROFILE

  diff   Preview per-user convergence
  apply  Converge the selected per-user profile
  check  Check the live per-user profile

Homebrew packages, identities, secrets, and host-wide settings remain separate.`;

const delegate = Effect.fn("delegateDotfilesCommand")(function*(owner: string, args: readonly string[], commandName: string, profile: string) {
  const runner = yield* CommandRunner;
  const result = yield* runner.run(resolve(repoRoot, owner), args, {
    cwd: repoRoot,
    stdin: "inherit",
    output: "inherit",
  });
  if (result.status !== 0) {
    return yield* fail(`${owner} failed; fix the error above and rerun ./dotfiles ${commandName} ${profile}`, result.status);
  }
});

const program = Effect.gen(function*() {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "-h" || args[0] === "--help")) {
    yield* Console.log(usage);
    return;
  }
  if (args.length !== 2) {
    yield* Console.error(usage);
    return yield* fail("invalid operator arguments", 2);
  }
  const [commandName, requestedProfile] = args;
  const model = yield* readProfileModelEffect(resolve(repoRoot, "chezmoi/.chezmoidata/profiles.json"));
  let profile: string;
  try {
    requireProfile(model, requestedProfile);
    profile = requestedProfile;
  } catch {
    yield* Console.error(`unsupported profile: ${requestedProfile}`);
    yield* Console.error(usage);
    return yield* fail("unsupported profile", 2);
  }

  yield* Console.error("Not included: Homebrew packages, identities, secrets, or host-wide settings.");
  switch (commandName) {
    case "diff":
      yield* Console.log(`Per-user convergence steps for ${profile}:`);
      yield* delegate("scripts/bootstrap/install.ts", ["--print-steps", "--profile", profile], commandName, profile);
      yield* Console.log("\nDotfile changes:");
      return yield* delegate("scripts/bootstrap/apply-dotfiles.ts", ["--profile", profile, "--dry-run", "--verbose"], commandName, profile);
    case "apply":
      return yield* delegate("scripts/bootstrap/install.ts", ["--profile", profile], commandName, profile);
    case "check":
      return yield* delegate("scripts/verify/bootstrap.ts", ["--profile", profile], commandName, profile);
    default:
      yield* Console.error(`unsupported command: ${commandName}`);
      yield* Console.error(usage);
      return yield* fail("unsupported command", 2);
  }
}).pipe(
  Effect.provide(CommandRunner.layer),
  Effect.provide(NodeServices.layer),
);

runMain(program);
