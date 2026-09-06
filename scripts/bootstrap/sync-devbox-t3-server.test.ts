import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {chmod, mkdir, mkdtemp, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {NodeServices} from "@effect/platform-node";
import {Effect} from "effect";
import {CommandRunner, CommandError, type CommandOptions} from "../lib/command.ts";
import {CliFailure} from "../lib/program.ts";

import {
  checkExitCode,
  createSyncBundle,
  exitCodes,
  installRequired,
  installSshArguments,
  parseArguments,
  parseT3Version,
  readScheduledTarget,
  remoteUpdate,
  selectWorkstationT3App,
  shellQuote,
  syncDevboxT3Server,
  type SyncOptions,
} from "./sync-devbox-t3-server.ts";

const target = "example@example-devbox";
const workstation = {app: "T3 Code.app", version: "0.0.35"};
const inspection = (version: string, state = "loaded", health = "healthy") =>
  `{"schema_version":1,"status":"ok","version":"${version}","service_state":"${state}","health":"${health}"}\n`;

type Call = {command: string; args: readonly string[]; options?: CommandOptions};

function fakeRunner(remote: {status: number; stdout: string} | "spawn-failure", installStatus = 0) {
  const calls: Call[] = [];
  const runner = CommandRunner.of({run: (command, args = [], options) => {
    calls.push({command, args, options});
    const remoteCommand = args.at(-1) ?? "";
    if (remoteCommand.includes("tar -xf -")) return Effect.succeed({status: installStatus, stdout: "", stderr: ""});
    if (remote === "spawn-failure") return Effect.fail(new CommandError({command, message: "ssh missing"}));
    return Effect.succeed({...remote, stderr: ""});
  }});
  return {calls, runner};
}

const dependencies = {detectWorkstation: () => workstation, bundle: () => Buffer.from("bundle")};

function sync(options: Partial<SyncOptions>, runner: CommandRunner["Service"], deps = dependencies) {
  return Effect.runPromise(
    syncDevboxT3Server({host: target, check: false, force: false, scheduled: false, ...options}, deps).pipe(
      Effect.provideService(CommandRunner, runner),
    ),
  );
}

test("accepts stable, prerelease, and copied exact versions", () => {
  assert.equal(parseT3Version("0.0.35"), "0.0.35");
  assert.equal(parseT3Version("t3@0.0.35"), "0.0.35");
  assert.equal(parseT3Version("npx t3@0.0.36-beta.1"), "0.0.36-beta.1");
});

test("parses explicit, check, force, and scheduled modes", () => {
  assert.deepEqual(parseArguments(["--host", target, "--version", "t3@0.0.35"]), {
    host: target, version: "0.0.35", check: false, force: false, scheduled: false,
  });
  assert.deepEqual(parseArguments(["--host", target, "--check"]), {
    host: target, version: undefined, check: true, force: false, scheduled: false,
  });
  assert.deepEqual(parseArguments(["--host", target, "--force"]), {
    host: target, version: undefined, check: false, force: true, scheduled: false,
  });
  assert.deepEqual(parseArguments(["--scheduled"]), {host: "", check: false, force: false, scheduled: true});
});

test("rejects implicit hosts, removed path options, mutable versions, and conflicting modes", () => {
  assert.throws(() => parseArguments(["--host", "example-devbox"]), /explicit user@host/);
  assert.throws(() => parseArguments(["--host", "user@host", "--workspace", "/tmp/workspace"]), /unknown argument: --workspace/);
  assert.throws(() => parseArguments(["--host", "user@host", "--remote-dotfiles", "/tmp/dotfiles"]), /unknown argument: --remote-dotfiles/);
  assert.throws(() => parseArguments(["--host", "user@host", "--version", "t3@latest"]), /exact T3 version/);
  assert.throws(() => parseArguments(["--host", "user@host", "--check", "--force"]), /--check cannot be combined/);
  assert.throws(() => parseArguments(["--scheduled", "--host", "user@host"]), /--scheduled takes no other arguments/);
});

test("selects the installed T3 Code app without assuming a release channel", () => {
  assert.equal(selectWorkstationT3App(["T3 Code (Alpha).app"]), "T3 Code (Alpha).app");
  assert.equal(selectWorkstationT3App(["T3 Code (Alpha).app", "T3 Code.app"]), "T3 Code.app");
  assert.throws(() => selectWorkstationT3App(["T3 Code (Alpha).app", "T3 Code (Beta).app"]), /multiple T3 Code apps/);
});

test("quotes remote arguments without shell interpolation", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("path with ' quote"), "'path with '\\'' quote'");
  assert.deepEqual(installSshArguments(target, "0.0.35").slice(0, 3), ["-o", "BatchMode=yes", target]);
});

test("installs bundled dependencies through Corepack", () => {
  assert.match(remoteUpdate, /^corepack pnpm install --frozen-lockfile --prod$/m);
  assert.doesNotMatch(remoteUpdate, /^pnpm install/m);
});

test("bundles the portable remote installer sources", () => {
  const bundle = createSyncBundle();
  const result = spawnSync("tar", ["-tf", "-"], {encoding: "utf8", input: bundle});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^scripts\/bootstrap\/install-devbox-service-daemons\.ts$/m);
  assert.match(result.stdout, /^scripts\/lib\/launchd\.ts$/m);
  assert.match(result.stdout, /^scripts\/secrets\/sops-devbox-sudo\.ts$/m);
});

test("a matching healthy server is never reinstalled or restarted", async () => {
  const {calls, runner} = fakeRunner({status: 0, stdout: inspection("0.0.35")});
  const result = await sync({}, runner);
  assert.equal(result.action, "unchanged");
  assert.equal(result.requested_version, "0.0.35");
  assert.equal(calls.length, 1, "only the read-only inspection runs");
  assert.doesNotMatch(calls[0]?.args.at(-1) ?? "", /tar -xf/);
});

test("version drift installs the workstation version over SSH with the bundle on stdin", async () => {
  const {calls, runner} = fakeRunner({status: 0, stdout: inspection("0.0.34")});
  const result = await sync({}, runner);
  assert.equal(result.action, "installed");
  assert.equal(result.requested_version, "0.0.35");
  assert.match(result.reason ?? "", /server runs 0.0.34, expected 0.0.35/);
  assert.equal(calls.length, 2);
  const installCall = calls[1]!;
  assert.equal(installCall.command, "ssh");
  assert.ok(installCall.args.includes("BatchMode=yes"));
  assert.match(installCall.args.at(-1) ?? "", /'0\.0\.35'$/);
  assert.ok(installCall.options?.stdin instanceof Uint8Array);
  assert.equal(Buffer.from(installCall.options.stdin).toString(), "bundle");
});

test("an unhealthy server at the same version and --force both reinstall", async () => {
  const unhealthy = fakeRunner({status: 0, stdout: inspection("0.0.35", "unloaded", "unhealthy")});
  assert.equal((await sync({}, unhealthy.runner)).action, "installed");
  const forced = fakeRunner({status: 0, stdout: inspection("0.0.35")});
  const result = await sync({force: true}, forced.runner);
  assert.equal(result.action, "installed");
  assert.equal(result.reason, "forced");
  assert.equal(forced.calls.length, 2);
});

test("an explicit --version overrides workstation detection for the decision", async () => {
  const {calls, runner} = fakeRunner({status: 0, stdout: inspection("0.0.36")});
  assert.equal((await sync({version: "0.0.36"}, runner)).action, "unchanged");
  assert.equal(calls.length, 1);
});

test("an unreachable devbox or missing workstation app is a reported skip without install", async () => {
  const unreachable = fakeRunner({status: 255, stdout: ""});
  const transport = await sync({}, unreachable.runner);
  assert.equal(transport.action, "skipped");
  assert.equal(transport.comparison?.error?.kind, "transport");
  assert.equal(unreachable.calls.length, 1);

  const noSsh = fakeRunner("spawn-failure");
  assert.equal((await sync({}, noSsh.runner)).comparison?.error?.code, "ssh_unavailable");

  const noApp = fakeRunner({status: 0, stdout: inspection("0.0.35")});
  const local = await sync({}, noApp.runner, {...dependencies, detectWorkstation: () => { throw new Error("missing T3 Code app"); }});
  assert.equal(local.action, "skipped");
  assert.equal(local.comparison?.error?.kind, "workstation");
  assert.equal(noApp.calls.length, 0);
});

test("--force installs the detected version even when the inspection is unavailable", async () => {
  const {calls, runner} = fakeRunner({status: 255, stdout: ""});
  const result = await sync({force: true}, runner);
  assert.equal(result.action, "installed");
  assert.equal(result.requested_version, "0.0.35");
  assert.equal(calls.length, 2, "force bypasses the comparison but keeps the explicit target");
});

test("install failures propagate the remote status", async () => {
  const {runner} = fakeRunner({status: 0, stdout: inspection("0.0.34")}, 7);
  const failure = await Effect.runPromise(
    syncDevboxT3Server({host: target, check: false, force: false, scheduled: false}, dependencies).pipe(
      Effect.provideService(CommandRunner, runner), Effect.flip,
    ),
  );
  assert.ok(failure instanceof CliFailure);
  assert.equal(failure.exitCode, 7);
});

test("--check reports without installing and maps outcomes to distinct exit codes", async () => {
  const same = fakeRunner({status: 0, stdout: inspection("0.0.35")});
  const clean = await sync({check: true}, same.runner);
  assert.equal(clean.action, "checked");
  assert.equal(same.calls.length, 1);
  assert.equal(checkExitCode(clean.comparison!), exitCodes.clean);

  const drifted = fakeRunner({status: 0, stdout: inspection("0.0.34")});
  assert.equal(checkExitCode((await sync({check: true}, drifted.runner)).comparison!), exitCodes.drift);

  const down = fakeRunner({status: 255, stdout: ""});
  assert.equal(checkExitCode((await sync({check: true}, down.runner)).comparison!), exitCodes.unavailable);
  assert.notEqual(exitCodes.drift, exitCodes.unavailable);
});

test("install decisions are explicit about their reason", () => {
  const comparison = {
    schema_version: 1 as const, target, status: "clean" as const, workstation,
    server: {version: "0.0.35", service_state: "loaded" as const, health: "healthy" as const},
    versions_match: true, error: null,
  };
  assert.equal(installRequired(comparison, "0.0.35", false).install, false);
  assert.equal(installRequired(comparison, "0.0.36", false).install, true);
  assert.equal(installRequired(comparison, "0.0.35", true).reason, "forced");
});

test("the scheduled target file must be an owner-only user@host line", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dotfiles-t3-target-"));
  t.after(() => rm(home, {recursive: true, force: true}));
  const read = () => Effect.runPromise(readScheduledTarget(home, process.getuid?.()).pipe(Effect.provide(NodeServices.layer)));
  const flipped = () => Effect.runPromise(readScheduledTarget(home, process.getuid?.()).pipe(Effect.provide(NodeServices.layer), Effect.flip));
  assert.equal(await read(), undefined);
  await mkdir(join(home, ".config/dotfiles"), {recursive: true});
  const path = join(home, ".config/dotfiles/t3-server-target");
  await writeFile(path, ` ${target}\n`, {mode: 0o600});
  assert.equal(await read(), target);
  await chmod(path, 0o644);
  assert.match(String(await flipped()), /owner-only/);
  await chmod(path, 0o600);
  await writeFile(path, "example-devbox\n", {mode: 0o600});
  assert.match(String(await flipped()), /user@host/);
  await rm(path);
  await writeFile(join(home, "elsewhere"), target, {mode: 0o600});
  await symlink(join(home, "elsewhere"), path);
  assert.match(String(await flipped()), /owner-only/);
});
