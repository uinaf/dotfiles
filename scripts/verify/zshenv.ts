#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Cause, Console, Effect, FileSystem } from "effect";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../lib/command.ts";
import { fail, runMain } from "../lib/program.ts";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const program = Effect.scoped(Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* CommandRunner;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "dotfiles-zshenv." });
  const directory = join(home, ".config/dotfiles");
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  yield* fs.symlink(join(repoRoot, "chezmoi/dot_zshenv"), join(home, ".zshenv"));
  const run = Effect.fn("zshenvCheck")(function*(code: string) {
    const result = yield* runner.run("/usr/bin/env", ["-i", `HOME=${home}`, "PATH=/usr/bin:/bin", "/bin/zsh", "-c", code]);
    if (result.status !== 0) return yield* fail(result.stderr || code);
  });
  for (const path of [".config/dotfiles/zshenv.local", ...["dot_config", "private_dot_config"].flatMap((config) => ["dotfiles", "private_dotfiles"].flatMap((dotfiles) => ["zshenv.local", "private_zshenv.local", "zshenv.local.tmpl", "private_zshenv.local.tmpl"].map((name) => `chezmoi/${config}/${dotfiles}/${name}`)))]) {
    const result = yield* runner.run("git", ["-C", repoRoot, "check-ignore", "-q", path]);
    if (result.status !== 0) return yield* fail(`overlay source path is not ignored by Git: ${path}`);
  }
  yield* run('[[ "$LANG" == en_US.UTF-8 ]]; [[ -z ${DOTFILES_ZSHENV_LOCAL+x} ]]; [[ -z ${HOMEBREW_NO_AUTO_UPDATE+x} ]]');
  yield* fs.writeFileString(join(directory, "devbox.env"), "", { mode: 0o600 });
  yield* run('[[ "$AGENT_CLI_CREDENTIAL_STORE" == file ]]; [[ "$HOMEBREW_NO_AUTO_UPDATE" == 1 ]]');
  const overlay = join(directory, "zshenv.local");
  yield* fs.writeFileString(overlay, "export DOTFILES_ZSHENV_LOCAL=from-local\nexport LANG=overlay-wins\n", { mode: 0o600 });
  yield* run('[[ "$DOTFILES_ZSHENV_LOCAL" == from-local ]]; [[ "$LANG" == overlay-wins ]]');
  const external = join(home, "zshenv.external");
  yield* fs.rename(overlay, external);
  yield* fs.symlink(external, overlay);
  yield* run('[[ -z ${DOTFILES_ZSHENV_LOCAL+x} ]]');
  yield* fs.remove(overlay);
  yield* fs.rename(external, overlay);
  if ((process.getuid?.() ?? 0) !== 0) {
    yield* fs.chmod(overlay, 0o000);
    yield* run('[[ -z ${DOTFILES_ZSHENV_LOCAL+x} ]]');
    yield* fs.chmod(overlay, 0o600);
  }
  yield* fs.remove(overlay);
  yield* fs.makeDirectory(overlay);
  yield* run('[[ -z ${DOTFILES_ZSHENV_LOCAL+x} ]]');
  yield* fs.remove(overlay, { recursive: true });
  const externalParent = join(home, "dotfiles.external");
  yield* fs.rename(directory, externalParent);
  yield* fs.symlink(externalParent, directory);
  yield* fs.writeFileString(join(externalParent, "zshenv.local"), "export DOTFILES_ZSHENV_LOCAL=from-parent-link\n", { mode: 0o600 });
  yield* run('[[ -z ${DOTFILES_ZSHENV_LOCAL+x} ]]');
  yield* Console.log("zshenv overlay ok");
}).pipe(Effect.catchCause((cause) => fail(Cause.pretty(cause))), Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer)));
runMain(program);
