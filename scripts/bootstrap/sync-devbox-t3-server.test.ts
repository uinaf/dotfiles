import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {chmod, mkdir, mkdtemp, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {NodeServices} from "@effect/platform-node";
import {Effect} from "effect";
import {CommandRunner, CommandError, type CommandOptions, type CommandResult} from "../lib/command.ts";
import {CliFailure} from "../lib/program.ts";
import {sshArguments} from "../verify/t3-server-version.ts";

import {
  checkExitCode,
  checkoutRefusal,
  createSyncBundle,
  exitCodes,
  gitArchiveArguments,
  installRequired,
  installSshArguments,
  installTimeoutMs,
  parseArguments,
  parseT3Version,
  readScheduledTarget,
  remoteUpdate,
  REPO_ROOT,
  selectWorkstationT3App,
  shellQuote,
  SYNC_BUNDLE_PATHS,
  syncDevboxT3Server,
  type SyncOptions,
} from "./sync-devbox-t3-server.ts";

const target = "example@example-devbox";
const workstation = {app: "T3 Code.app", version: "0.0.35"};
const inspection = (version: string, state = "loaded", health = "healthy") =>
  `{"schema_version":1,"status":"ok","version":"${version}","service_state":"${state}","health":"${health}"}\n`;
const remoteError = (code: string) => `{"schema_version":1,"status":"error","error_code":"${code}"}\n`;

type Call = {command: string; args: readonly string[]; options?: CommandOptions};
type Checkout = {status?: string; headRef?: string; remoteHead?: string; head?: string; remoteTip?: string};

const sha = "c".repeat(40);
const publishedCheckout: Required<Checkout> = {
  status: "", headRef: "refs/heads/main\n", remoteHead: "refs/remotes/origin/main\n", head: `${sha}\n`, remoteTip: `${sha}\n`,
};

function fakeRunner(remote: {status: number; stdout: string} | "spawn-failure", installStatus = 0, checkout: Checkout = {}) {
  const calls: Call[] = [];
  const tree = {...publishedCheckout, ...checkout};
  const ok = (stdout: string, extra: Partial<CommandResult> = {}) => Effect.succeed({status: 0, stdout, stderr: "", ...extra});
  const runner = CommandRunner.of({run: (command, args = [], options) => {
    calls.push({command, args, options});
    if (command === "git") {
      const sub = args.slice(2);
      if (sub[0] === "archive") return ok("", {stdoutBytes: new Uint8Array(Buffer.from("bundle"))});
      if (sub[0] === "status") return ok(tree.status);
      if (sub[0] === "symbolic-ref" && sub[1] === "HEAD") return tree.headRef ? ok(tree.headRef) : Effect.succeed({status: 128, stdout: "", stderr: "fatal: ref HEAD is not a symbolic ref"});
      if (sub[0] === "symbolic-ref") return ok(tree.remoteHead);
      if (sub[0] === "rev-parse" && sub[1] === "HEAD") return ok(tree.head);
      if (sub[0] === "rev-parse") return ok(tree.remoteTip);
      return Effect.fail(new CommandError({command, message: `unexpected git ${sub.join(" ")}`}));
    }
    const remoteCommand = args.at(-1) ?? "";
    if (remoteCommand.includes("tar -xf -")) return Effect.succeed({status: installStatus, stdout: "", stderr: ""});
    if (remote === "spawn-failure") return Effect.fail(new CommandError({command, message: "ssh missing"}));
    return Effect.succeed({...remote, stderr: ""});
  }});
  return {calls, runner};
}

const dependencies = {detectWorkstation: () => workstation};
const defaults: SyncOptions = {host: target, check: false, force: false, scheduled: false, allowDirty: false};

function sync(options: Partial<SyncOptions>, runner: CommandRunner["Service"], deps = dependencies) {
  return Effect.runPromise(
    syncDevboxT3Server({...defaults, ...options}, deps).pipe(Effect.provideService(CommandRunner, runner)),
  );
}

function syncFailure(options: Partial<SyncOptions>, runner: CommandRunner["Service"], deps = dependencies) {
  return Effect.runPromise(
    syncDevboxT3Server({...defaults, ...options}, deps).pipe(Effect.provideService(CommandRunner, runner), Effect.flip),
  );
}

const installCalls = (calls: Call[]) => calls.filter((call) => call.command === "ssh" && (call.args.at(-1) ?? "").includes("tar -xf -"));

test("accepts stable, prerelease, and copied exact versions", () => {
  assert.equal(parseT3Version("0.0.35"), "0.0.35");
  assert.equal(parseT3Version("t3@0.0.35"), "0.0.35");
  assert.equal(parseT3Version("npx t3@0.0.36-beta.1"), "0.0.36-beta.1");
});

test("parses explicit, check, force, allow-dirty, and scheduled modes", () => {
  assert.deepEqual(parseArguments(["--host", target, "--version", "t3@0.0.35"]), {
    host: target, version: "0.0.35", check: false, force: false, scheduled: false, allowDirty: false,
  });
  assert.deepEqual(parseArguments(["--host", target, "--check"]), {
    host: target, version: undefined, check: true, force: false, scheduled: false, allowDirty: false,
  });
  assert.deepEqual(parseArguments(["--host", target, "--force", "--allow-dirty"]), {
    host: target, version: undefined, check: false, force: true, scheduled: false, allowDirty: true,
  });
  assert.deepEqual(parseArguments(["--scheduled"]), {host: "", check: false, force: false, scheduled: true, allowDirty: false});
});

test("rejects implicit hosts, removed path options, mutable versions, and conflicting modes", () => {
  assert.throws(() => parseArguments(["--host", "example-devbox"]), /explicit user@host/);
  assert.throws(() => parseArguments(["--host", "user@host", "--workspace", "/tmp/workspace"]), /unknown argument: --workspace/);
  assert.throws(() => parseArguments(["--host", "user@host", "--remote-dotfiles", "/tmp/dotfiles"]), /unknown argument: --remote-dotfiles/);
  assert.throws(() => parseArguments(["--host", "user@host", "--version", "t3@latest"]), /exact T3 version/);
  assert.throws(() => parseArguments(["--host", "user@host", "--check", "--force"]), /--check cannot be combined/);
  assert.throws(() => parseArguments(["--scheduled", "--host", "user@host"]), /--scheduled takes no other arguments/);
  assert.throws(() => parseArguments(["--scheduled", "--allow-dirty"]), /--scheduled takes no other arguments/);
  assert.throws(() => parseArguments(["--host", "user@host", "--check", "--allow-dirty"]), /--check cannot be combined/);
});

test("selects the installed T3 Code app without assuming a release channel", () => {
  assert.equal(selectWorkstationT3App(["T3 Code (Alpha).app"]), "T3 Code (Alpha).app");
  assert.equal(selectWorkstationT3App(["T3 Code (Alpha).app", "T3 Code.app"]), "T3 Code.app");
  assert.throws(() => selectWorkstationT3App(["T3 Code (Alpha).app", "T3 Code (Beta).app"]), /multiple T3 Code apps/);
});

test("quotes remote arguments without shell interpolation", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("path with ' quote"), "'path with '\\'' quote'");
  assert.equal(installSshArguments(target, "0.0.35").at(-2), target);
});

test("the install SSH session is hardened like the inspection session", () => {
  const args = installSshArguments(target, "0.0.35");
  const options = args.filter((_, index) => index > 0 && args[index - 1] === "-o");
  for (const expected of [
    "BatchMode=yes", "ClearAllForwardings=yes", "ConnectTimeout=10", "ControlMaster=no", "ForwardAgent=no",
    "ServerAliveCountMax=2", "ServerAliveInterval=5", "StrictHostKeyChecking=yes", "UpdateHostKeys=no",
  ]) assert.ok(options.includes(expected), `missing -o ${expected}`);
  assert.deepEqual(options, sshArguments(target).filter((_, index, all) => index > 0 && all[index - 1] === "-o"));
  assert.equal(args.indexOf(target), args.length - 2, "options precede the host; nothing follows the command");
});

test("installs bundled dependencies through Corepack", () => {
  assert.match(remoteUpdate, /^corepack pnpm install --frozen-lockfile --prod$/m);
  assert.doesNotMatch(remoteUpdate, /^pnpm install/m);
});

test("bundles the portable remote installer sources from committed HEAD, not the working tree", async () => {
  assert.deepEqual(gitArchiveArguments.slice(0, 5), ["-C", REPO_ROOT, "archive", "--format=tar", "HEAD"]);
  assert.deepEqual(gitArchiveArguments.slice(6), SYNC_BUNDLE_PATHS);
  const bundle = await Effect.runPromise(createSyncBundle().pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer)));
  const result = spawnSync("tar", ["-tf", "-"], {encoding: "utf8", input: bundle});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^scripts\/bootstrap\/install-devbox-service-daemons\.ts$/m);
  assert.match(result.stdout, /^scripts\/lib\/launchd\.ts$/m);
  assert.match(result.stdout, /^scripts\/secrets\/sops-devbox-sudo\.ts$/m);
  const committed = spawnSync("git", ["-C", REPO_ROOT, "show", "HEAD:scripts/lib/program.ts"], {encoding: "utf8"}).stdout;
  const extracted = spawnSync("tar", ["-xOf", "-", "scripts/lib/program.ts"], {encoding: "utf8", input: bundle}).stdout;
  assert.equal(extracted, committed, "bundle content is HEAD's, byte for byte");
});

test("checkout refusal: scheduled needs a published HEAD; interactive needs a clean tree or --allow-dirty", () => {
  const clean = {dirty: undefined, unpublished: undefined};
  const dirty = {dirty: "uncommitted changes: scripts/lib/program.ts", unpublished: undefined};
  const ahead = {dirty: undefined, unpublished: "HEAD abc is not origin/main def"};
  assert.equal(checkoutRefusal(clean, {scheduled: true, allowDirty: false}), undefined);
  assert.match(checkoutRefusal(dirty, {scheduled: true, allowDirty: false}) ?? "", /scheduled sync refuses.*uncommitted/);
  assert.match(checkoutRefusal(ahead, {scheduled: true, allowDirty: false}) ?? "", /scheduled sync refuses.*not origin\/main/);
  assert.equal(checkoutRefusal(ahead, {scheduled: false, allowDirty: false}), undefined, "interactive installs may ship a feature branch's HEAD");
  assert.match(checkoutRefusal(dirty, {scheduled: false, allowDirty: false}) ?? "", /--allow-dirty/);
  assert.equal(checkoutRefusal(dirty, {scheduled: false, allowDirty: true}), undefined);
});

test("a dirty tree is refused before any bundle or install, and --allow-dirty ships HEAD", async () => {
  const dirtyTree = {status: " M scripts/lib/program.ts\n"};
  const refused = fakeRunner({status: 0, stdout: inspection("0.0.34")}, 0, dirtyTree);
  const failure = await syncFailure({}, refused.runner);
  assert.ok(failure instanceof CliFailure);
  assert.match(failure.message, /uncommitted changes: scripts\/lib\/program\.ts.*--allow-dirty/);
  assert.equal(installCalls(refused.calls).length, 0);
  assert.ok(!refused.calls.some((call) => call.command === "git" && call.args[2] === "archive"), "no archive before the refusal");

  const allowed = fakeRunner({status: 0, stdout: inspection("0.0.34")}, 0, dirtyTree);
  assert.equal((await sync({allowDirty: true}, allowed.runner)).action, "installed");
  assert.equal(installCalls(allowed.calls).length, 1);
  assert.ok(allowed.calls.some((call) => call.command === "git" && call.args[2] === "archive" && call.args[4] === "HEAD"));
});

test("scheduled installs refuse a dirty tree or an unpublished HEAD as a failure, not a skip", async () => {
  for (const [label, checkout, pattern] of [
    ["dirty", {status: "?? scripts/lib/new.ts\n"}, /uncommitted changes/],
    ["feature branch", {headRef: "refs/heads/feature\n"}, /not on the default branch main/],
    ["detached", {headRef: ""}, /not on the default branch main/],
    ["ahead of origin", {head: `${"d".repeat(40)}\n`}, /is not origin\/main/],
  ] as const) {
    const {calls, runner} = fakeRunner({status: 0, stdout: inspection("0.0.34")}, 0, checkout);
    const failure = await syncFailure({scheduled: true}, runner);
    assert.ok(failure instanceof CliFailure, label);
    assert.match(failure.message, /scheduled sync refuses an unpublished checkout/, label);
    assert.match(failure.message, pattern, label);
    assert.equal(installCalls(calls).length, 0, label);
  }
  const published = fakeRunner({status: 0, stdout: inspection("0.0.34")});
  assert.equal((await sync({scheduled: true}, published.runner)).action, "installed");
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
  const installCall = installCalls(calls)[0]!;
  assert.equal(installCall.command, "ssh");
  assert.ok(installCall.args.includes("BatchMode=yes"));
  assert.match(installCall.args.at(-1) ?? "", /'0\.0\.35'$/);
  assert.ok(installCall.options?.stdin instanceof Uint8Array);
  assert.equal(Buffer.from(installCall.options.stdin).toString(), "bundle");
  assert.equal(installCall.options?.timeoutMs, installTimeoutMs, "the install is bounded through the runner");
  assert.ok(calls.some((call) => call.command === "git" && call.args[2] === "archive"), "the bundle came from git archive");
});

test("an unhealthy server at the same version and --force both reinstall", async () => {
  const unhealthy = fakeRunner({status: 0, stdout: inspection("0.0.35", "unloaded", "unhealthy")});
  assert.equal((await sync({}, unhealthy.runner)).action, "installed");
  const forced = fakeRunner({status: 0, stdout: inspection("0.0.35")});
  const result = await sync({force: true}, forced.runner);
  assert.equal(result.action, "installed");
  assert.equal(result.reason, "forced");
  assert.equal(installCalls(forced.calls).length, 1);
});

test("an explicit --version overrides workstation detection for the decision", async () => {
  const {calls, runner} = fakeRunner({status: 0, stdout: inspection("0.0.36")});
  assert.equal((await sync({version: "0.0.36"}, runner)).action, "unchanged");
  assert.equal(calls.length, 1);
});

test("only a transport failure is a reported skip; it never installs", async () => {
  for (const scheduled of [false, true]) {
    const unreachable = fakeRunner({status: 255, stdout: ""});
    const transport = await sync({scheduled}, unreachable.runner);
    assert.equal(transport.action, "skipped");
    assert.equal(transport.comparison?.error?.kind, "transport");
    assert.equal(unreachable.calls.length, 1);

    const noSsh = fakeRunner("spawn-failure");
    const spawn = await sync({scheduled}, noSsh.runner);
    assert.equal(spawn.action, "skipped");
    assert.equal(spawn.comparison?.error?.code, "ssh_unavailable");
  }
});

test("a workstation inspection failure fails in every mode", async () => {
  for (const scheduled of [false, true]) {
    const noApp = fakeRunner({status: 0, stdout: inspection("0.0.35")});
    const failure = await syncFailure({scheduled}, noApp.runner, {detectWorkstation: () => { throw new Error("missing T3 Code app"); }});
    assert.ok(failure instanceof CliFailure);
    assert.match(failure.message, /missing T3 Code app/);
    assert.equal(noApp.calls.length, 0);
  }
});

test("a remote structure error fails the step in scheduled mode instead of skipping silently", async () => {
  for (const code of ["unsafe_service_plist", "invalid_service_identity", "invalid_service_entrypoint", "missing_service_plist"]) {
    const {calls, runner} = fakeRunner({status: 0, stdout: remoteError(code)});
    const failure = await syncFailure({scheduled: true}, runner);
    assert.ok(failure instanceof CliFailure, code);
    assert.match(failure.message, new RegExp(code), code);
    assert.equal(installCalls(calls).length, 0, code);
  }
  const garbage = fakeRunner({status: 0, stdout: "not json\n"});
  assert.match((await syncFailure({scheduled: true}, garbage.runner)).message, /invalid_remote_protocol/);
});

test("--force installs the detected version even when the inspection is unavailable", async () => {
  const {calls, runner} = fakeRunner({status: 255, stdout: ""});
  const result = await sync({force: true}, runner);
  assert.equal(result.action, "installed");
  assert.equal(result.requested_version, "0.0.35");
  assert.equal(installCalls(calls).length, 1, "force bypasses the comparison but keeps the explicit target");
});

test("install failures propagate the remote status", async () => {
  const {runner} = fakeRunner({status: 0, stdout: inspection("0.0.34")}, 7);
  const failure = await syncFailure({}, runner);
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
