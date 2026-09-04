#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Cause, Console, Effect, FileSystem } from "effect";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner, type CommandResult } from "../lib/command.ts";
import { bundleCheckArgs, profileBrewfiles } from "../lib/homebrew.ts";
import { fail, runMain } from "../lib/program.ts";
import { readPersistedProfile, resolveProfile } from "../profiles/current.ts";
import { readProfileModelEffect, requireProfile } from "../profiles/model.ts";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const modelPath = join(repoRoot, "chezmoi/.chezmoidata/profiles.json");

const program = Effect.scoped(Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* CommandRunner;
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "dotfiles-profiles." });
  const model = yield* readProfileModelEffect(modelPath);
  const profiles = ["personal-workstation", "personal-devbox", "workstation", "devbox"] as const;
  assert.deepEqual(Object.keys(model.profiles).sort(), [...profiles].sort());
  const run = (command: string, args: readonly string[] = [], options: { env?: Readonly<Record<string, string>>; cwd?: string } = {}): Effect.Effect<CommandResult, unknown> =>
    runner.run(command, args, { env: options.env, cwd: options.cwd });
  for (const profile of profiles) requireProfile(model, profile);
  assert.throws(() => requireProfile(model, "unsupported"));
  assert.equal(requireProfile(model, "workstation").capabilities.requiresSopsIdentity, false);
  for (const profile of ["personal-workstation", "personal-devbox", "devbox"]) {
    assert.equal(requireProfile(model, profile).capabilities.requiresSopsIdentity, true);
  }
  assert.deepEqual(profileBrewfiles(model, "devbox"), ["Brewfile", "Brewfile.developer", "Brewfile.devbox"]);
  assert.deepEqual(profileBrewfiles(model, "personal-devbox"), ["Brewfile", "Brewfile.developer", "Brewfile.devbox", "Brewfile.personal"]);
  assert.deepEqual(profileBrewfiles(model, "workstation"), ["Brewfile", "Brewfile.developer", "Brewfile.workstation"]);
  assert.deepEqual(profileBrewfiles(model, "personal-workstation"), ["Brewfile", "Brewfile.developer", "Brewfile.workstation", "Brewfile.personal"]);
  for (const profile of ["personal-devbox", "devbox"]) {
    assert.deepEqual(bundleCheckArgs(model, profile, "Brewfile"), ["bundle", "check", "--no-upgrade", "--file", "Brewfile"]);
  }
  for (const profile of ["personal-workstation", "workstation"]) {
    assert.deepEqual(bundleCheckArgs(model, profile, "Brewfile"), ["bundle", "check", "--file", "Brewfile"]);
  }

  for (const script of ["scripts/bootstrap/configure-power.ts", "scripts/verify/bootstrap.ts"]) {
    const result = yield* run(process.execPath, [join(repoRoot, script), "workstation", "devbox"]);
    assert.notEqual(result.status, 0, `${script} accepted duplicate profiles`);
  }
  const profileHome = join(temporary, "profile-resolution");
  const marker = join(profileHome, ".config/dotfiles/profile");
  yield* fs.makeDirectory(join(profileHome, ".config/dotfiles"), { recursive: true });
  yield* fs.writeFileString(marker, " \tpersonal-devbox\r\n", { mode: 0o600 });
  assert.equal(yield* resolveProfile(undefined, { HOME: profileHome, DOTFILES_PROFILE: "workstation" }), "personal-devbox");
  yield* fs.remove(marker);
  assert.equal(yield* resolveProfile(undefined, { HOME: profileHome, DOTFILES_PROFILE: " devbox " }), "devbox");
  assert.equal((yield* resolveProfile(undefined, { HOME: profileHome, DOTFILES_PROFILE: "" }).pipe(Effect.flip)).exitCode, 1);
  assert.equal((yield* resolveProfile(undefined, { HOME: profileHome, DOTFILES_PROFILE: "invalid" }).pipe(Effect.flip)).exitCode, 2);
  yield* fs.symlink(join(profileHome, "missing"), marker);
  assert.equal((yield* resolveProfile(undefined, { HOME: profileHome, DOTFILES_PROFILE: "workstation" }).pipe(Effect.flip)).exitCode, 3);
  yield* fs.remove(marker);
  yield* fs.writeFileString(marker, "devbox\nextra\n", { mode: 0o600 });
  assert.equal((yield* readPersistedProfile(marker).pipe(Effect.option))._tag, "None");
  yield* fs.writeFileString(marker, "devbox\n", { mode: 0o666 });
  yield* fs.chmod(marker, 0o666);
  assert.equal((yield* readPersistedProfile(marker).pipe(Effect.option))._tag, "None");

  const agentHome = join(temporary, "agent-home");
  yield* fs.makeDirectory(join(agentHome, ".config/dotfiles"), { recursive: true });
  yield* fs.writeFileString(join(agentHome, ".config/dotfiles/profile"), "personal-devbox\n", { mode: 0o600 });
  const resolved = yield* run(process.execPath, [join(repoRoot, "scripts/agents/resolve-profile.ts"), "--expected", "personal-devbox"], { env: { HOME: agentHome } });
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(resolved.stdout.trim(), "personal-devbox");
  assert.equal((yield* run(process.execPath, [join(repoRoot, "scripts/agents/resolve-profile.ts"), "--expected", "devbox"], { env: { HOME: agentHome } })).status, 3);

  const canonicalSymlinkHome = join(temporary, "canonical-symlink-home");
  const canonicalTarget = join(temporary, "canonical-symlink-target");
  yield* fs.makeDirectory(join(canonicalSymlinkHome, ".config"), { recursive: true });
  yield* fs.makeDirectory(canonicalTarget);
  yield* fs.symlink(canonicalTarget, join(canonicalSymlinkHome, ".config/dotfiles"));
  assert.notEqual((yield* run(process.execPath, [join(repoRoot, "scripts/bootstrap/apply-dotfiles.ts"), "--profile", "devbox"], { env: { HOME: canonicalSymlinkHome } })).status, 0);
  assert.deepEqual(yield* fs.readDirectory(canonicalTarget), []);

  const brewfile = (name: string) => fs.readFileString(join(repoRoot, name));
  const base = yield* brewfile("Brewfile");
  for (const entry of ['brew "gh"', 'cask "google-chrome"']) assert.match(base, new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  const developer = yield* brewfile("Brewfile.developer");
  for (const entry of ['cask "codex"', 'cask "claude-code@latest"', 'cask "uinaf/tap/slopguard"', 'brew "watchman"', 'brew "awscli"']) assert.ok(developer.split("\n").includes(entry));
  const personal = yield* brewfile("Brewfile.personal");
  for (const entry of ['brew "asc"', 'brew "uinaf/tap/attach"', 'brew "openclaw/tap/crabbox"', 'brew "putdotio/tap/putio-cli"']) assert.ok(personal.split("\n").includes(entry));
  const workstation = yield* brewfile("Brewfile.workstation");
  for (const entry of ['cask "ghostty"', 'cask "1password"', 'cask "chatgpt"', 'cask "claude"', 'cask "cursor"', 'cask "t3-code"', 'cask "zed"', 'brew "ykman"']) assert.ok(workstation.split("\n").includes(entry));

  for (const profile of profiles) {
    const destination = join(temporary, `render-${profile}`);
    yield* fs.makeDirectory(destination);
    const data = JSON.stringify({ dotfilesProfile: profile });
    const rendered = yield* run("chezmoi", ["--source", join(repoRoot, "chezmoi"), "--destination", destination, "--override-data", data, "cat", join(destination, ".config/dotfiles/profile")]);
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.equal(rendered.stdout.trim(), profile);
    const zshrc = yield* run("chezmoi", ["--source", join(repoRoot, "chezmoi"), "--destination", destination, "--override-data", data, "cat", join(destination, ".zshrc")]);
    assert.match(zshrc.stdout, /^export EDITOR="vim"$/m);
    assert.match(zshrc.stdout, /^export VISUAL="vim"$/m);
  }
  const developerSteps = (yield* run(process.execPath, [join(repoRoot, "scripts/bootstrap/install.ts"), "--print-steps", "--profile", "workstation"])).stdout.trim().split("\n");
  for (const step of ["apply-dotfiles", "install-runtimes", "install-repository-dependencies", "install-cursor-agent", "trust-agent-worktrees", "install-gh-extensions", "configure-codex", "sync-agents"]) assert.ok(developerSteps.includes(step));

  const appliedHome = join(temporary, "devbox-applied");
  yield* fs.makeDirectory(appliedHome);
  const applied = yield* run(process.execPath, [join(repoRoot, "scripts/bootstrap/apply-dotfiles.ts"), "--profile", "devbox"], { env: { HOME: appliedHome } });
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal((yield* fs.readFileString(join(appliedHome, ".config/dotfiles/profile"))).trim(), "devbox");
  for (const rejected of ["Library/Application Support/com.mitchellh.ghostty"]) {
    assert.equal(yield* fs.exists(join(appliedHome, rejected)), false);
  }
  const gitconfig = yield* fs.readFileString(join(appliedHome, ".gitconfig"));
  assert.match(gitconfig, /^\[core\]$/m);
  assert.match(gitconfig, /^\[include\]$/m);
  yield* Console.log("ok profile layers and applied dotfiles");
}).pipe(Effect.catchCause((cause) => fail(Cause.pretty(cause))), Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer)));

runMain(program);
