#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem } from "effect";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../lib/command.ts";
import { fail, runMain } from "../lib/program.ts";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const installer = join(repoRoot, "scripts/bootstrap/install-gh-app-auth.ts");
const fixtureSha = "c4d80ff42526308bd27fc8b458e2c256bfced14cf6d90c4ce28afa3aa5ccbae3";

const program = Effect.scoped(Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* CommandRunner;
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "dotfiles-gh-app-auth." });
  const bin = join(temporary, "bin");
  const archive = join(temporary, "source.tar.gz");
  const log = join(temporary, "install.log");
  yield* fs.makeDirectory(bin);
  yield* fs.writeFileString(archive, "fixture archive\n");
  yield* fs.writeFileString(log, "");
  yield* fs.writeFileString(join(bin, "curl"), `#!/bin/sh
printf 'curl %s\\n' "$*" >> "$FAKE_INSTALL_LOG"
while [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then shift; cp "$FAKE_SOURCE_ARCHIVE" "$1"; exit; fi; shift; done
exit 64
`, { mode: 0o700 });
  yield* fs.writeFileString(join(bin, "shasum"), `#!/bin/sh
printf '%s  source.tar.gz\\n' "$FAKE_SOURCE_SHA256"
`, { mode: 0o700 });
  yield* fs.writeFileString(join(bin, "tar"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  yield* fs.writeFileString(join(bin, "mise"), `#!/bin/sh
printf 'mise %s\\n' "$*" >> "$FAKE_INSTALL_LOG"
while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; output="$1"; break; fi; shift; done
[ -n "\${output:-}" ] || exit 64
printf '%s\\n' '#!/bin/sh' '[ "$1 $2" = "exec --help" ]' > "$output"
chmod 700 "$output"
`, { mode: 0o700 });
  yield* fs.writeFileString(join(bin, "gh"), `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$FAKE_INSTALL_LOG"
[ "$*" = 'app-auth exec --help' ]
`, { mode: 0o700 });
  const base = { PATH: `${bin}:/usr/bin:/bin`, FAKE_INSTALL_LOG: log, FAKE_SOURCE_ARCHIVE: archive, FAKE_SOURCE_SHA256: fixtureSha };
  const execute = (home: string, extra: Readonly<Record<string, string>> = {}) => runner.run(process.execPath, [installer], { env: { ...base, HOME: home, ...extra } });

  const defaultHome = join(temporary, "default-home");
  const installed = yield* execute(defaultHome, { GH_APP_AUTH_GO_VERSION: "1.26.6" });
  assert.equal(installed.status, 0, installed.stderr);
  const defaultCommit = "620f73d8e27a81ea5736acbf5643b461da61c0f4";
  assert.match(yield* fs.readFileString(log), new RegExp(`curl .*https://codeload.github.com/AmadeusITGroup/gh-app-auth/tar.gz/${defaultCommit}`));
  assert.equal((yield* fs.readFileString(join(defaultHome, ".local/share/gh/extensions/gh-app-auth/.dotfiles-source"))).trim(),
    `commit=${defaultCommit}\nsource_sha256=${fixtureSha}\ngo=1.26.6`);

  const home = join(temporary, "home");
  yield* fs.writeFileString(log, "");
  const custom = { GH_APP_AUTH_SOURCE_COMMIT: "test-commit", GH_APP_AUTH_SOURCE_URL: "https://example.invalid/source.tar.gz", GH_APP_AUTH_SOURCE_SHA256: fixtureSha, GH_APP_AUTH_GO_VERSION: "1.26.6" };
  const result = yield* execute(home, custom);
  assert.equal(result.status, 0, result.stderr);
  const installDirectory = join(home, ".local/share/gh/extensions/gh-app-auth");
  assert.equal((yield* fs.stat(join(installDirectory, "gh-app-auth"))).mode & 0o777, 0o700);
  assert.equal((yield* fs.stat(join(installDirectory, ".dotfiles-source"))).mode & 0o777, 0o600);
  const firstLog = yield* fs.readFileString(log);
  assert.match(firstLog, /curl .*https:\/\/example\.invalid\/source\.tar\.gz/);
  assert.match(firstLog, /mise x --yes go@1\.26\.6 -- go build -trimpath -buildvcs=false -ldflags=-s -w/);
  assert.match(firstLog, /^gh app-auth exec --help$/m);
  yield* fs.writeFileString(log, "");
  assert.equal((yield* execute(home, custom)).status, 0);
  assert.equal((yield* fs.readFileString(log)).trim(), "gh app-auth exec --help");

  const badHome = join(temporary, "bad-home");
  const bad = yield* execute(badHome, { ...custom, GH_APP_AUTH_SOURCE_SHA256: "0".repeat(64) });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /source checksum mismatch/);
  assert.equal(yield* fs.exists(join(badHome, ".local/share/gh/extensions/gh-app-auth/gh-app-auth")), false);
  yield* Console.log("ok assistant gh-app-auth installer is pinned, idempotent, and fail-closed");
}).pipe(Effect.catch((error) => fail(error instanceof Error ? error.message : String(error))), Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer)));

runMain(program);
