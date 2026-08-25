#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Cause, Console, Effect, FileSystem } from "effect";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../lib/command.ts";
import { fail, runMain } from "../lib/program.ts";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const program = Effect.scoped(Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* CommandRunner;
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "dotfiles-brew-devbox." });
  const bin = join(temporary, "bin");
  const prefix = join(temporary, "prefix");
  const external = join(temporary, "external-homebrew.plist");
  yield* fs.makeDirectory(bin);
  yield* fs.makeDirectory(prefix);
  yield* fs.writeFileString(external, '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>version</key><integer>1</integer><key>capabilities</key><array/></dict></plist>\n', { mode: 0o600 });
  yield* fs.writeFileString(join(bin, "brew"), `#!/bin/sh
if [ "\${1:-}" = --prefix ]; then printf '%s\\n' "$FAKE_BREW_PREFIX"; exit 0; fi
{ printf 'umask=%s\\n' "$(umask)"; printf 'no_auto_update=%s\\n' "\${HOMEBREW_NO_AUTO_UPDATE:-}"; [ -z "\${HOMEBREW_BUNDLE_DOTFILES_PROFILE:-}" ] || printf 'profile=%s\\n' "$HOMEBREW_BUNDLE_DOTFILES_PROFILE"; printf 'arg=%s\\n' "$@"; } >> "$FAKE_BREW_LOG"
if [ -n "\${FAKE_BREW_OUTPUT_DIR:-}" ]; then mkdir "$FAKE_BREW_OUTPUT_DIR/directory"; : > "$FAKE_BREW_OUTPUT_DIR/file"; : > "$FAKE_BREW_OUTPUT_DIR/executable"; chmod a+x "$FAKE_BREW_OUTPUT_DIR/executable"; fi
if [ "\${1:-}" = bundle ] && [ "\${2:-}" = cleanup ]; then while [ "$#" -gt 0 ]; do if [ "$1" = --file ]; then sed -n -E 's/^((brew|cask|tap) ".*")$/cleanup_entry=\\1/p' "$2" >> "$FAKE_BREW_LOG"; break; fi; shift; done; fi
exit "\${FAKE_BREW_EXIT:-0}"
`, { mode: 0o755 });
  const path = `${bin}:${process.env.PATH || "/usr/bin:/bin"}`;
  const execute = (script: string, args: readonly string[], log: string, extra: Readonly<Record<string, string>> = {}, home = process.env.HOME || temporary) => runner.run(process.execPath, [join(repoRoot, script), ...args], {
    env: { HOME: home, PATH: path, FAKE_BREW_LOG: log, FAKE_BREW_PREFIX: prefix, DOTFILES_EXTERNAL_HOMEBREW_FILE: external, ...extra },
  });
  const directLog = join(temporary, "direct.log");
  const output = join(temporary, "output");
  yield* fs.writeFileString(directLog, "");
  yield* fs.makeDirectory(output);
  const direct = yield* execute("scripts/bootstrap/brew-devbox.ts", ["upgrade", "lima", "usage"], directLog, { FAKE_BREW_OUTPUT_DIR: output });
  assert.equal(direct.status, 0, direct.stderr);
  const log = yield* fs.readFileString(directLog);
  assert.match(log, /^umask=0027$/m);
  assert.match(log, /^arg=upgrade$/m);
  assert.match(log, /^arg=lima$/m);
  assert.equal((yield* fs.stat(join(output, "directory"))).mode & 0o777, 0o750);
  assert.equal((yield* fs.stat(join(output, "file"))).mode & 0o777, 0o640);
  assert.equal((yield* fs.stat(join(output, "executable"))).mode & 0o777, 0o751);
  const writable = join(prefix, "group-writable");
  yield* fs.makeDirectory(writable, { mode: 0o770 });
  yield* fs.chmod(writable, 0o770);
  const refused = yield* execute("scripts/bootstrap/brew-devbox.ts", ["upgrade", "unsafe"], directLog);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Homebrew prefix contains group-writable content/);
  yield* fs.chmod(writable, 0o750);
  const failed = yield* execute("scripts/bootstrap/brew-devbox.ts", ["failure-path"], directLog, { FAKE_BREW_EXIT: "37" });
  assert.equal(failed.status, 37);

  const bundle = Effect.fn("runBrewBundleFixture")(function*(profile: string, args: readonly string[] = []) {
    const bundleLog = join(temporary, `${profile}-${args.join("-") || "bundle"}.log`);
    yield* fs.writeFileString(bundleLog, "");
    const result = yield* execute("scripts/bootstrap/brew-bundle.ts", [...args, profile], bundleLog);
    assert.equal(result.status, 0, result.stderr);
    return yield* fs.readFileString(bundleLog);
  });
  const devbox = yield* bundle("devbox");
  assert.equal((devbox.match(/^arg=bundle$/gm) || []).length, 3);
  assert.equal((devbox.match(/^profile=devbox$/gm) || []).length, 3);
  for (const file of ["Brewfile", "Brewfile.developer", "Brewfile.devbox"]) assert.ok(devbox.includes(`arg=${join(repoRoot, file)}`));
  const personal = yield* bundle("personal-devbox");
  assert.equal((personal.match(/^arg=bundle$/gm) || []).length, 4);
  for (const file of ["Brewfile", "Brewfile.developer", "Brewfile.devbox", "Brewfile.personal"]) assert.ok(personal.includes(`arg=${join(repoRoot, file)}`));
  const assistant = yield* bundle("assistant");
  assert.equal((assistant.match(/^arg=bundle$/gm) || []).length, 2);
  assert.equal(assistant.includes(`arg=${join(repoRoot, "Brewfile.developer")}`), false);
  const shared = yield* bundle("devbox", ["--shared-only"]);
  assert.equal((shared.match(/^arg=bundle$/gm) || []).length, 1);
  const cleanup = yield* bundle("devbox", ["--cleanup"]);
  assert.match(cleanup, /^arg=cleanup$/m);
  assert.match(cleanup, /^arg=--force$/m);
  assert.match(cleanup, /^cleanup_entry=brew "pi-coding-agent"$/m);
  assert.match(cleanup, /^cleanup_entry=brew "yt-dlp"$/m);
  assert.equal((yield* fs.glob("Brewfile.composed.*", { root: repoRoot })).length, 0);
  assert.equal((yield* execute("scripts/bootstrap/brew-bundle.ts", ["--cleanup", "--shared-only", "devbox"], directLog)).status, 2);
  assert.equal((yield* execute("scripts/bootstrap/brew-bundle.ts", ["--shared-only"], directLog)).status, 2);
  yield* Console.log("ok shared Homebrew mutations require the prefix owner and verification stays read-only");
}).pipe(Effect.catchCause((cause) => fail(Cause.pretty(cause))), Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer)));
runMain(program);
