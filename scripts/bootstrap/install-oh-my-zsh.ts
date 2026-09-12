#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem } from "effect";
import { join } from "node:path";
import { CommandRunner } from "../lib/command.ts";
import { fail, runMain } from "../lib/program.ts";

// oh-my-zsh is a git checkout the shell sources; its own updater is disabled
// in .zshrc so `./dotfiles maintain` is the only thing that moves it.
const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* CommandRunner;
  const update = process.argv.includes("--update");
  const home = process.env.HOME || "";
  if (!home && !process.env.OH_MY_ZSH_DIR) return yield* fail("HOME is required");
  const target = process.env.OH_MY_ZSH_DIR || join(home, ".oh-my-zsh");
  const remote = process.env.OH_MY_ZSH_REMOTE || "https://github.com/ohmyzsh/ohmyzsh.git";

  if (yield* fs.exists(join(target, ".git"))) {
    // An interrupted clone leaves .git without a usable tree.
    if (!(yield* fs.exists(join(target, "oh-my-zsh.sh")))) return yield* fail(`${target} is an incomplete checkout; move it aside and rerun`);
    if (!update) return;
    yield* Console.log("updating oh-my-zsh");
    const pulled = yield* runner.run("git", ["-C", target, "pull", "--ff-only", "--quiet"], { output: "inherit" });
    if (pulled.status !== 0) return yield* fail(`oh-my-zsh update exited ${pulled.status}`, pulled.status);
    return;
  }
  if (yield* fs.exists(target)) return yield* fail(`${target} exists but is not a git checkout; move it aside`);
  yield* Console.log("installing oh-my-zsh");
  const cloned = yield* runner.run("git", ["clone", "--depth", "1", "--quiet", remote, target], { output: "inherit" });
  if (cloned.status !== 0) return yield* fail(`oh-my-zsh clone exited ${cloned.status}`, cloned.status);
}).pipe(
  Effect.provide(CommandRunner.layer),
  Effect.provide(NodeServices.layer),
);

runMain(program);
