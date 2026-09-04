#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem } from "effect";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../lib/command.ts";
import {
  launchdLabel,
  parsePendingInstallScripts,
  resolveLaunchdNamespaceContract,
  validateT3Version,
} from "../lib/launchd.ts";
import { CliFailure, fail, runMain } from "../lib/program.ts";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const installer = join(repoRoot, "scripts/bootstrap/install-devbox-service-daemons.ts");

const program = Effect.scoped(Effect.gen(function*() {
  const runner = yield* CommandRunner;
  const runInstaller = (args: readonly string[]) => runner.run(process.execPath, [installer, ...args]);
  const expected = [
    "local.dotfiles.colima.example",
    "local.dotfiles.t3-code.example",
  ].join("\n");
  const generic = yield* runInstaller(["--user", "example", "--print-labels"]);
  assert.equal(generic.status, 0);
  assert.equal(generic.stdout.trim(), expected);
  for (const namespace of ["org.example.dotfiles", "org.example_team.dotfiles"]) {
    const custom = yield* runInstaller(["--user", "example", "--namespace", namespace, "--print-labels"]);
    assert.equal(custom.status, 0);
    assert.equal(custom.stdout.trim(), ["colima", "t3-code"].map((service) => `${namespace}.${service}.example`).join("\n"));
  }
  assert.throws(() => launchdLabel("colima", ""));
  assert.throws(() => launchdLabel("", "example"));

  const invalid = yield* runInstaller(["--user", "example", "--namespace", "invalid namespace", "--print-labels"]);
  assert.notEqual(invalid.status, 0);
  for (const args of [
    ["--user", "example", "--colima", "--openclaw-port", "18790"],
    ["--user", "example", "--colima", "--openclaw-wrapper", "/tmp/wrapper"],
    ["--user", "example", "--openclaw"],
    ["--user", "example", "--allow-openclaw-restart"],
  ]) {
    const rejected = yield* runInstaller(args);
    assert.equal(rejected.status, 2);
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /unknown argument:/);
  }
  assert.notEqual((yield* runInstaller(["--user", "example", "--colima", "--t3-version", "1.2.3"])).status, 0);

  assert.equal(validateT3Version("0.0.34-nightly.20260823.1166"), true);
  assert.equal(validateT3Version("latest; unsafe"), false);
  assert.deepEqual(parsePendingInstallScripts('{"allowScripts":[{"name":"msgpackr-extract"},{"name":"node-pty"}]}', new Set(["msgpackr-extract", "node-pty"])), ["msgpackr-extract", "node-pty"]);
  assert.throws(() => parsePendingInstallScripts('{"allowScripts":[{"name":"unexpected-native-addon"}]}', new Set(["node-pty"])));
  assert.throws(() => parsePendingInstallScripts('{"allowScripts":{}}', new Set()));

  const fs = yield* FileSystem.FileSystem;
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "dotfiles-service-labels." });
  const namespaceFile = join(temporary, "launchd-namespace");
  yield* fs.writeFileString(namespaceFile, "org.example.dotfiles\n", { mode: 0o600 });
  assert.equal(yield* resolveLaunchdNamespaceContract("", namespaceFile), "org.example.dotfiles");
  assert.equal(yield* resolveLaunchdNamespaceContract("org.example.dotfiles", namespaceFile), "org.example.dotfiles");
  const conflicting = yield* resolveLaunchdNamespaceContract("local.dotfiles", namespaceFile).pipe(Effect.flip);
  assert.ok(conflicting instanceof CliFailure);
  assert.equal(conflicting.exitCode, 3);
  yield* fs.chmod(namespaceFile, 0o644);
  assert.equal((yield* resolveLaunchdNamespaceContract("", namespaceFile).pipe(Effect.option))._tag, "None");
  yield* fs.chmod(namespaceFile, 0o600);
  yield* fs.writeFileString(namespaceFile, "org.example.dotfiles\nsecond.record\n");
  assert.equal((yield* resolveLaunchdNamespaceContract("", namespaceFile).pipe(Effect.option))._tag, "None");
  yield* fs.remove(namespaceFile);
  yield* fs.symlink(join(temporary, "missing"), namespaceFile);
  assert.equal((yield* resolveLaunchdNamespaceContract("local.dotfiles", namespaceFile).pipe(Effect.option))._tag, "None");
  yield* Console.log("ok LaunchDaemon labels are vendor-neutral and configurable");
}).pipe(
  Effect.catch((error) => fail(error instanceof Error ? error.message : String(error))),
  Effect.provide(CommandRunner.layer),
  Effect.provide(NodeServices.layer),
));

runMain(program);
