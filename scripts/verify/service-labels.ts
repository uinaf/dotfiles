#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem } from "effect";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../lib/command.ts";
import {
  launchdLabel,
  openclawRestartSudoersName,
  openclawRestartSudoersRule,
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
    "local.dotfiles.openclaw-gateway.example",
    "local.dotfiles.colima.example",
    "local.dotfiles.t3-code.example",
  ].join("\n");
  const generic = yield* runInstaller(["--user", "example", "--print-labels"]);
  assert.equal(generic.status, 0);
  assert.equal(generic.stdout.trim(), expected);
  for (const namespace of ["org.example.dotfiles", "org.example_team.dotfiles"]) {
    const custom = yield* runInstaller(["--user", "example", "--namespace", namespace, "--print-labels"]);
    assert.equal(custom.status, 0);
    assert.equal(custom.stdout.trim(), ["openclaw-gateway", "colima", "t3-code"].map((service) => `${namespace}.${service}.example`).join("\n"));
  }
  assert.equal(openclawRestartSudoersRule("example", "local.dotfiles.openclaw-gateway.example"),
    "example ALL=(root) NOPASSWD: /bin/launchctl kickstart -k system/local.dotfiles.openclaw-gateway.example");
  assert.throws(() => openclawRestartSudoersRule("bad user", "local.dotfiles.openclaw-gateway.example"));
  assert.throws(() => openclawRestartSudoersRule("example", "local.dotfiles.openclaw-gateway.example *"));
  assert.equal(openclawRestartSudoersName("a.b", 501), "dotfiles-openclaw-restart-a_b-501");
  assert.notEqual(openclawRestartSudoersName("a.b", 501), openclawRestartSudoersName("a_b", 502));
  assert.throws(() => openclawRestartSudoersName("example", Number.NaN));
  assert.throws(() => launchdLabel("openclaw-gateway", ""));
  assert.throws(() => launchdLabel("", "example"));

  const invalid = yield* runInstaller(["--user", "example", "--namespace", "invalid namespace", "--print-labels"]);
  assert.notEqual(invalid.status, 0);
  for (const args of [
    ["--user", "example", "--colima", "--openclaw-port", "18790"],
    ["--user", "example", "--colima", "--openclaw-wrapper", "/tmp/wrapper"],
    ["--user", "example", "--openclaw", "--openclaw-port", "99999999999999999999"],
    ["--user", "example", "--colima", "--t3-version", "1.2.3"],
  ]) assert.notEqual((yield* runInstaller(args)).status, 0);

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
