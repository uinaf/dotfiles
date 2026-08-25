#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem } from "effect";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../lib/command.ts";
import { fail, runMain } from "../lib/program.ts";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const configurator = join(repoRoot, "scripts/bootstrap/configure-assistant-github-app.ts");

const program = Effect.scoped(Effect.gen(function*() {
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR"]) delete process.env[key];
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* CommandRunner;
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "dotfiles-assistant-app." });
  const home = join(temporary, "home");
  const bin = join(temporary, "bin");
  const repos = join(temporary, "repos");
  const keyDirectory = join(home, ".config/gh/extensions/gh-app-auth/keys");
  const extensionDirectory = join(home, ".local/share/gh/extensions/gh-app-auth");
  for (const path of [bin, join(home, ".config/dotfiles"), keyDirectory, extensionDirectory, ...["one", "two", "ssh"].map((name) => join(repos, name))]) {
    yield* fs.makeDirectory(path, { recursive: true, mode: 0o700 });
  }
  yield* fs.writeFileString(join(home, ".config/dotfiles/profile"), "assistant\n");
  yield* fs.writeFileString(join(home, ".gitconfig"), "[include]\n\tpath = ~/.gitconfig.local\n[include]\n\tpath = ~/.config/dotfiles/github-app.gitconfig\n");
  const key = join(keyDirectory, "example-app.pem");
  yield* fs.writeFileString(key, "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n", { mode: 0o600 });
  yield* fs.writeFileString(join(extensionDirectory, "gh-app-auth"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const gitPath = (yield* runner.run("/usr/bin/which", ["git"])).stdout.trim();
  assert.ok(gitPath);
  yield* fs.writeFileString(join(bin, "git"), `#!/bin/sh
if [ "\${1:-}" = -C ] && [ "\${3:-}" = ls-remote ]; then printf 'git %s\\n' "$*" >> "$FAKE_APP_LOG"; exit 0; fi
exec "$REAL_GIT" "$@"
`, { mode: 0o700 });
  yield* fs.writeFileString(join(bin, "gh"), `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$FAKE_APP_LOG"
case "\${1:-} \${2:-}" in
  'auth status') [ "\${FAKE_HUMAN_AUTH:-0}" = 1 ] ;;
  'app-auth setup') exit 0 ;;
  'app-auth list') printf 'NAME\\tAPP ID\\tINSTALLATION ID\\tPATTERNS\\tPRIORITY\\tKEY SOURCE\\nexample-app\\t123\\t456\\tgithub.com/example/one, github.com/example/two\\t5\\tfixture\\n' ;;
  'app-auth test') exit 0 ;;
  'app-auth exec') while [ "$#" -gt 0 ]; do if [ "$1" = api ]; then shift; printf '%s\\n' "\${1#repos/}"; exit 0; fi; shift; done; exit 64 ;;
  *) exit 64 ;;
esac
`, { mode: 0o700 });
  for (const name of ["one", "two", "ssh"]) assert.equal((yield* runner.run(gitPath, ["-C", join(repos, name), "init", "-q"])).status, 0);
  assert.equal((yield* runner.run(gitPath, ["-C", join(repos, "one"), "remote", "add", "origin", "https://github.com/example/one.git"])).status, 0);
  assert.equal((yield* runner.run(gitPath, ["-C", join(repos, "two"), "remote", "add", "origin", "https://github.com/example/two.git"])).status, 0);
  assert.equal((yield* runner.run(gitPath, ["-C", join(repos, "ssh"), "remote", "add", "origin", "git@github.com:example/ssh.git"])).status, 0);
  const log = join(temporary, "app.log");
  yield* fs.writeFileString(log, "");
  const base = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, REAL_GIT: gitPath, FAKE_APP_LOG: log };
  const execute = (args: readonly string[], extra: Readonly<Record<string, string>> = {}) => runner.run(process.execPath, [configurator, ...args], { env: { ...base, ...extra } });
  const common = ["--name", "example-app", "--app-id", "123", "--installation-id", "456"];
  const configured = yield* execute([...common, "--repo", join(repos, "one"), "--repo", join(repos, "two")]);
  assert.equal(configured.status, 0, configured.stderr);
  const include = join(home, ".config/dotfiles/github-app.gitconfig");
  assert.equal((yield* fs.stat(include)).mode & 0o777, 0o600);
  const usePath = yield* runner.run(gitPath, ["config", "--file", include, "--get", "credential.https://github.com.useHttpPath"]);
  assert.equal(usePath.stdout.trim(), "true");
  const helpers = yield* runner.run(gitPath, ["config", "--file", include, "--get-all", "credential.https://github.com.helper"]);
  assert.deepEqual(helpers.stdout.trimEnd().split("\n"), ["", `!${join(extensionDirectory, "gh-app-auth")} git-credential`]);
  const output = yield* fs.readFileString(log);
  assert.match(output, /gh app-auth setup --app-id 123 --installation-id 456/);
  assert.match(output, /gh app-auth exec --repo github\.com\/example\/one -- gh api repos\/example\/one --jq \.full_name/);
  assert.match(output, /ls-remote origin HEAD/);
  const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
  const before = hash(yield* fs.readFile(include));
  const checked = yield* execute(["--check", ...common, "--repo", join(repos, "one"), "--repo", "github.com/example/two"]);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(hash(yield* fs.readFile(include)), before);
  const human = yield* execute(["--check", ...common, "--repo", join(repos, "one"), "--repo", "github.com/example/two"], { FAKE_HUMAN_AUTH: "1" });
  assert.equal(human.status, 1);
  assert.match(human.stderr, /a human gh auth login exists/);
  yield* fs.chmod(key, 0o644);
  const unsafe = yield* execute([...common, "--repo", join(repos, "one")]);
  assert.equal(unsafe.status, 1);
  assert.match(unsafe.stderr, /permissions must be owner-only/);
  yield* fs.chmod(key, 0o600);
  const ssh = yield* execute([...common, "--repo", join(repos, "ssh")]);
  assert.equal(ssh.status, 1);
  assert.match(ssh.stderr, /must use an HTTPS github\.com origin/);
  yield* Console.log("ok assistant GitHub App configuration is global, exact-scope, idempotent, and fail-closed");
}).pipe(Effect.catch((error) => fail(error instanceof Error ? error.message : String(error))), Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer)));

runMain(program);
