#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option, Schema } from "effect";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner, runCommand } from "../lib/command.ts";
import {
  launchdLabel,
  parsePendingInstallScripts,
  plistXml,
  resolveLaunchdNamespace,
  resolveLaunchdNamespaceContract,
  validateT3Version,
} from "../lib/launchd.ts";
import { CliFailure, fail, runMain } from "../lib/program.ts";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const usage = `Usage:
  scripts/bootstrap/install-devbox-service-daemons.ts --user <name> [services]

Services:
  --colima           Run the user's colima-ensure script once at system boot.
  --t3-code          Run a pinned T3 Code server at system boot.

Options:
  --check            Verify the selected LaunchDaemons without changing them.
  --print-labels     Print the generic labels for the selected user and exit.
  --namespace NAME   Stable label namespace; defaults to local.dotfiles.
  --t3-version VERSION
                      Exact npm T3 Code version; requires --t3-code.
  --t3-working-directory PATH
                      Server working directory; defaults to the user's home.

The installer must run as root on macOS. It creates root-owned system
LaunchDaemons that drop privileges to the selected user.`;

const InstallerOptions = Schema.Struct({
  user: Schema.NonEmptyString,
  namespace: Schema.String,
  colima: Schema.Boolean,
  t3Code: Schema.Boolean,
  t3Version: Schema.String,
  t3WorkingDirectory: Schema.String,
  check: Schema.Boolean,
  printLabels: Schema.Boolean,
});
type InstallerOptions = typeof InstallerOptions.Type;

type Target = { readonly user: string; readonly uid: number; readonly group: string; readonly home: string };
type ServiceContext = {
  readonly options: InstallerOptions;
  readonly target: Target;
  readonly namespace: string;
  readonly labels: { readonly colima: string; readonly t3: string };
  readonly launchDaemonDir: string;
};
type T3Service = {
  readonly node: string;
  readonly npm: string;
  readonly npmMajor: number;
  readonly workingDirectory: string;
  readonly serviceDirectory: string;
  readonly entrypoint: string;
};

const parseArguments = Effect.fn("parseServiceInstallerArguments")(function*(argv: readonly string[]) {
  const values = {
    user: "", namespace: process.env.DOTFILES_LAUNCHD_NAMESPACE || "",
    colima: false, t3Code: false, t3Version: "", t3WorkingDirectory: "", check: false, printLabels: false,
  };
  const args = [...argv];
  const take = (flag: string): string => {
    const value = args.shift();
    if (!value) throw new CliFailure({ exitCode: 1, message: `${flag} requires a value` });
    return value;
  };
  while (args.length > 0) {
    const flag = args.shift()!;
    switch (flag) {
      case "--user": values.user = take(flag); break;
      case "--namespace": values.namespace = take(flag); break;
      case "--colima": values.colima = true; break;
      case "--t3-code": values.t3Code = true; break;
      case "--t3-version": values.t3Version = take(flag); break;
      case "--t3-working-directory": values.t3WorkingDirectory = take(flag); break;
      case "--check": values.check = true; break;
      case "--print-labels": values.printLabels = true; break;
      case "-h": case "--help": yield* Console.log(usage); return undefined;
      default: yield* Console.error(usage); return yield* fail(`unknown argument: ${flag}`, 2);
    }
  }
  const options = yield* Schema.decodeUnknownEffect(InstallerOptions)(values).pipe(
    Effect.mapError((error) => new CliFailure({ exitCode: 1, message: error.message })),
  );
  if (!/^[A-Za-z0-9._-]+$/.test(options.user)) return yield* fail(`unsupported user name: ${options.user}`);
  if (!options.t3Code && (options.t3Version || options.t3WorkingDirectory)) {
    return yield* fail("--t3-version and --t3-working-directory require --t3-code");
  }
  if (options.t3Code && !options.t3Version) return yield* fail("--t3-code requires --t3-version");
  return options;
});

const run = (command: string, args: readonly string[] = [], inherit = false) =>
  runCommand(command, args, { output: inherit ? "inherit" : "capture" });

const checked = Effect.fn("runCheckedServiceCommand")(function*(command: string, args: readonly string[] = [], inherit = false) {
  const result = yield* run(command, args, inherit);
  if (result.status !== 0) return yield* fail(`${command} ${args.join(" ")} exited ${result.status}`);
  return result;
});

const resolveTarget = Effect.fn("resolveServiceTarget")(function*(user: string) {
  const uidResult = yield* run("/usr/bin/id", ["-u", user]);
  if (uidResult.status !== 0 || !/^\d+$/.test(uidResult.stdout.trim())) return yield* fail(`unknown user: ${user}`);
  const group = yield* checked("/usr/bin/id", ["-gn", user]);
  const homeResult = yield* checked("/usr/bin/dscl", [".", "-read", `/Users/${user}`, "NFSHomeDirectory"]);
  const home = homeResult.stdout.trim().split(/\s+/).at(-1) || "";
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(home).pipe(Effect.option);
  if (!home || Option.isNone(info) || info.value.type !== "Directory") return yield* fail(`missing home for ${user}`);
  return { user, uid: Number(uidResult.stdout.trim()), group: group.stdout.trim(), home } satisfies Target;
});

function labels(user: string, namespace: string) {
  return {
    colima: launchdLabel("colima", user, namespace),
    t3: launchdLabel("t3-code", user, namespace),
  };
}

const executable = Effect.fn("serviceExecutable")(function*(path: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(path).pipe(Effect.option);
  return Option.isSome(info) && info.value.type === "File" && (info.value.mode & 0o111) !== 0;
});

const findExecutable = Effect.fn("findServiceExecutable")(function*(target: Target, name: string) {
  for (const path of [join(target.home, ".local/bin", name), join(target.home, ".local/share/mise/shims", name), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`]) {
    if (yield* executable(path)) return path;
  }
  return undefined;
});

const runAsTarget = Effect.fn("runServiceCommandAsTarget")(function*(target: Target, command: string, args: readonly string[] = []) {
  const uid = process.getuid?.() ?? -1;
  if (uid === target.uid) return yield* checked(command, args);
  if (uid === 0) return yield* checked("/usr/bin/sudo", ["-u", target.user, "-H", command, ...args]);
  return yield* fail(`run this step as root or ${target.user}`);
});

const checkJob = Effect.fn("checkLaunchdJob")(function*(context: ServiceContext, label: string) {
  const plist = join(context.launchDaemonDir, `${label}.plist`);
  const stat = yield* checked("/usr/bin/stat", ["-f", "%Su:%Sg:%Lp", plist]);
  if (stat.stdout.trim() !== "root:wheel:644") return yield* fail(`${label} plist must be root:wheel mode 0644`);
  const status = yield* run("/bin/launchctl", ["print", `system/${label}`]);
  if (status.status !== 0) return yield* fail(`${label} is not loaded`);
  yield* Console.log(`ok ${label} loaded for ${context.target.user}`);
});

const healthT3 = Effect.fn("checkT3Health")(function*(context: ServiceContext) {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const result = yield* run("/usr/bin/curl", ["--fail", "--silent", "--show-error", "--max-time", "2", "http://127.0.0.1:3773/"]);
    if (result.status === 0) {
      yield* Console.log(`ok ${context.labels.t3} HTTP health for ${context.target.user}`);
      return;
    }
    yield* Effect.sleep("1 second");
  }
  return yield* fail(`${context.labels.t3} did not become healthy on http://127.0.0.1:3773/`);
});

const bootout = Effect.fn("bootoutLaunchdJob")(function*(label: string) {
  if ((yield* run("/bin/launchctl", ["print", `system/${label}`])).status !== 0) return;
  yield* checked("/bin/launchctl", ["bootout", `system/${label}`]);
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    if ((yield* run("/bin/launchctl", ["print", `system/${label}`])).status !== 0) return;
    yield* Effect.sleep("100 millis");
  }
  return yield* fail(`system/${label} remains loaded after bootout`);
});

const installJob = Effect.fn("installLaunchdJob")(function*(context: ServiceContext, source: string, label: string) {
  yield* bootout(label);
  const target = join(context.launchDaemonDir, `${label}.plist`);
  yield* checked("/usr/bin/install", ["-o", "root", "-g", "wheel", "-m", "0644", source, target]);
  yield* checked("/bin/launchctl", ["bootstrap", "system", target]);
  yield* checked("/bin/launchctl", ["enable", `system/${label}`]);
  yield* checked("/bin/launchctl", ["kickstart", "-k", `system/${label}`]);
  yield* checked("/bin/launchctl", ["print", `system/${label}`]);
  yield* Console.log(`installed ${label} for ${context.target.user}`);
});

const persistNamespace = Effect.fn("persistLaunchdNamespace")(function*(context: ServiceContext) {
  const fs = yield* FileSystem.FileSystem;
  const directory = join(context.target.home, ".config/dotfiles");
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  yield* fs.chmod(directory, 0o700);
  yield* fs.chown(directory, context.target.uid, -1);
  const destination = join(directory, "launchd-namespace");
  const temporary = join(directory, `.launchd-namespace.${process.pid}`);
  yield* fs.writeFileString(temporary, `${context.namespace}\n`, { mode: 0o600 });
  yield* fs.chown(temporary, context.target.uid, -1);
  yield* fs.rename(temporary, destination);
});

const writePlist = Effect.fn("writeServicePlist")(function*(path: string, xml: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(path, xml, { mode: 0o600 });
  yield* checked("/usr/bin/plutil", ["-lint", path]);
});

const prepareColima = Effect.fn("prepareColimaService")(function*(target: Target) {
  const binary = yield* findExecutable(target, "colima");
  if (!binary) return yield* fail("missing colima binary");
  const start = join(target.home, ".local/bin/colima-ensure");
  if (!(yield* executable(start))) return yield* fail(`missing executable ${start}`);
  return { binary, start };
});

const checkColima = Effect.fn("checkColimaService")(function*(context: ServiceContext, colima: { binary: string; start: string }) {
  yield* checkJob(context, context.labels.colima);
  const uid = process.getuid?.() ?? -1;
  if (uid === 0 || uid === context.target.uid) {
    const status = yield* runAsTarget(context.target, colima.binary, ["status"]);
    if (!/colima is running/i.test(`${status.stdout}\n${status.stderr}`)) return yield* fail(`${context.labels.colima} is loaded but Colima is not running`);
  } else yield* Console.log(`skipped ${context.labels.colima} functional check (requires root or ${context.target.user})`);
});

const installColima = Effect.fn("installColimaService")(function*(context: ServiceContext, temporary: string, colima: { binary: string; start: string }) {
  yield* runAsTarget(context.target, colima.start);
  const logDirectory = join(context.target.home, ".local/log/colima");
  yield* checked("/usr/bin/install", ["-d", "-o", context.target.user, "-g", context.target.group, "-m", "0750", logDirectory]);
  const plist = join(temporary, `${context.labels.colima}.plist`);
  yield* writePlist(plist, plistXml({ label: context.labels.colima, user: context.target.user, group: context.target.group,
    workingDirectory: context.target.home, stdout: join(logDirectory, "launchd.log"), stderr: join(logDirectory, "launchd-error.log"),
    arguments: [colima.start], keepAlive: false }));
  yield* installJob(context, plist, context.labels.colima);
  yield* checkColima(context, colima);
});

const resolveT3 = Effect.fn("resolveT3Service")(function*(context: ServiceContext) {
  const { target, options } = context;
  if (!validateT3Version(options.t3Version)) return yield* fail("T3 Code version must be one exact npm version");
  const workingDirectory = options.t3WorkingDirectory || target.home;
  if (!isAbsolute(workingDirectory)) return yield* fail("T3 Code working directory must be an absolute path");
  const fs = yield* FileSystem.FileSystem;
  const workingInfo = yield* fs.stat(workingDirectory).pipe(Effect.option);
  if (Option.isNone(workingInfo) || workingInfo.value.type !== "Directory") return yield* fail(`missing T3 Code working directory: ${workingDirectory}`);
  const node = yield* findExecutable(target, "node");
  const npm = yield* findExecutable(target, "npm");
  if (!node) return yield* fail(`missing Node for ${target.user}`);
  if (!npm) return yield* fail(`missing npm for ${target.user}`);
  const resolvedNode = (yield* runAsTarget(target, node, ["-p", "process.execPath"])).stdout.trim();
  if (!isAbsolute(resolvedNode) || !(yield* executable(resolvedNode))) return yield* fail(`resolved Node is not executable: ${resolvedNode}`);
  const npmVersion = (yield* runAsTarget(target, npm, ["--version"])).stdout.trim();
  const npmMajor = Number(npmVersion.split(".")[0]);
  if (!Number.isInteger(npmMajor)) return yield* fail(`unsupported npm version: ${npmVersion}`);
  const serviceDirectory = join(target.home, ".local/share/t3-code/service", options.t3Version);
  return { node: resolvedNode, npm, npmMajor, workingDirectory, serviceDirectory,
    entrypoint: join(serviceDirectory, "node_modules/t3/dist/bin.mjs") };
});

const inspectPendingScripts = Effect.fn("inspectT3InstallScripts")(function*(context: ServiceContext, t3: T3Service) {
  const result = yield* runAsTarget(context.target, t3.npm, ["install-scripts", "ls", "--prefix", t3.serviceDirectory, "--json"]);
  return yield* Effect.try({
    try: () => parsePendingInstallScripts(result.stdout, new Set(["msgpackr-extract", "node-pty"])),
    catch: (error) => new CliFailure({ exitCode: 1, message: error instanceof Error ? error.message : String(error) }),
  });
});

const prepareT3 = Effect.fn("prepareT3Service")(function*(context: ServiceContext, t3: T3Service, temporary: string) {
  yield* runAsTarget(context.target, "/usr/bin/install", ["-d", "-m", "0755", t3.serviceDirectory]);
  const fs = yield* FileSystem.FileSystem;
  let storedVersion = "";
  const packageJson = join(t3.serviceDirectory, "package.json");
  if (yield* fs.exists(packageJson)) {
    const result = yield* runAsTarget(context.target, t3.node, ["-e", "try { process.stdout.write(require(process.argv[1]).dependencies?.t3 ?? '') } catch {}", packageJson]);
    storedVersion = result.stdout;
  }
  if (storedVersion !== context.options.t3Version || !(yield* fs.exists(t3.entrypoint))) {
    const args = ["install", "--prefix", t3.serviceDirectory, "--save-exact", "--no-audit", "--no-fund"];
    if (t3.npmMajor >= 12) args.push("--ignore-scripts");
    args.push(`t3@${context.options.t3Version}`);
    yield* runAsTarget(context.target, t3.npm, args);
  }
  if (!(yield* fs.exists(t3.entrypoint))) return yield* fail("T3 Code package has no server entrypoint");
  if (t3.npmMajor >= 12) {
    const pending = yield* inspectPendingScripts(context, t3);
    if (pending.length > 0) yield* runAsTarget(context.target, t3.npm, ["install-scripts", "approve", ...pending, "--prefix", t3.serviceDirectory]);
    yield* runAsTarget(context.target, t3.npm, ["rebuild", "msgpackr-extract", "node-pty", "--prefix", t3.serviceDirectory, "--strict-allow-scripts", "--no-audit", "--no-fund"]);
    const remaining = yield* inspectPendingScripts(context, t3);
    if (remaining.length > 0) return yield* fail(`T3 Code install scripts remain blocked: ${remaining.join(", ")}`);
  }
  const logDirectory = join(context.target.home, "Library/Logs/t3-code");
  yield* runAsTarget(context.target, "/usr/bin/install", ["-d", "-m", "0755", logDirectory]);
  const plist = join(temporary, `${context.labels.t3}.plist`);
  yield* writePlist(plist, plistXml({ label: context.labels.t3, user: context.target.user, group: context.target.group,
    workingDirectory: t3.workingDirectory, stdout: join(logDirectory, "server.log"), stderr: join(logDirectory, "server-error.log"),
    arguments: [t3.node, t3.entrypoint, "serve", "--base-dir", join(context.target.home, ".t3")], processType: "Background",
    environment: { HOME: context.target.home, LOGNAME: context.target.user,
      PATH: `${context.target.home}/.local/bin:${context.target.home}/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      SHELL: "/bin/zsh", USER: context.target.user } }));
  yield* checked("/usr/bin/install", ["-o", context.target.user, "-g", context.target.group, "-m", "0644", plist, join(t3.serviceDirectory, `${context.labels.t3}.plist`)]);
  return plist;
});

const checkT3 = Effect.fn("checkT3Service")(function*(context: ServiceContext, t3: T3Service) {
  yield* checkJob(context, context.labels.t3);
  const result = yield* checked("/usr/bin/plutil", ["-extract", "ProgramArguments.1", "raw", join(context.launchDaemonDir, `${context.labels.t3}.plist`)]);
  if (result.stdout.trim() !== t3.entrypoint) return yield* fail(`${context.labels.t3} does not use T3 Code ${context.options.t3Version}`);
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(t3.entrypoint))) return yield* fail(`missing T3 Code entrypoint: ${t3.entrypoint}`);
  yield* healthT3(context);
});

const program = Effect.gen(function*() {
  const options = yield* parseArguments(process.argv.slice(2));
  if (!options) return;
  let namespace = yield* Effect.try({ try: () => resolveLaunchdNamespace(options.namespace), catch: (error) => error });
  if (options.printLabels) {
    if (process.platform === "darwin") {
      const target = yield* resolveTarget(options.user).pipe(Effect.option);
      if (Option.isSome(target)) namespace = yield* resolveLaunchdNamespaceContract(options.namespace, join(target.value.home, ".config/dotfiles/launchd-namespace"), target.value.uid);
    }
    const output = labels(options.user, namespace);
    yield* Console.log(`${output.colima}\n${output.t3}`);
    return;
  }
  if (process.platform !== "darwin") return yield* fail("this installer supports macOS only");
  if (!options.colima && !options.t3Code) return yield* fail("select at least one service");
  const target = yield* resolveTarget(options.user);
  namespace = yield* resolveLaunchdNamespaceContract(options.namespace, join(target.home, ".config/dotfiles/launchd-namespace"), target.uid);
  const context: ServiceContext = { options, target, namespace, labels: labels(target.user, namespace), launchDaemonDir: "/Library/LaunchDaemons" };
  const colima = options.colima ? yield* prepareColima(target) : undefined;
  const t3 = options.t3Code ? yield* resolveT3(context) : undefined;
  if (options.check) {
    if (colima) yield* checkColima(context, colima);
    if (t3) yield* checkT3(context, t3);
    return;
  }
  if ((process.getuid?.() ?? -1) !== 0) return yield* fail("run this installer as root");
  yield* Effect.scoped(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem;
    const temporary = yield* fs.makeTempDirectoryScoped({ directory: process.env.TMPDIR || "/tmp", prefix: "dotfiles-service-daemons." });
    let t3Plist: string | undefined;
    if (t3) t3Plist = yield* prepareT3(context, t3, temporary);
    yield* persistNamespace(context);
    if (colima) yield* installColima(context, temporary, colima);
    if (t3 && t3Plist) { yield* installJob(context, t3Plist, context.labels.t3); yield* healthT3(context); }
  }));
  yield* Console.log("devbox service daemon installation ok");
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

runMain(program);
