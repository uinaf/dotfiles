#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option } from "effect";
import { join } from "node:path";
import { CommandRunner, runChecked, runCommand } from "../lib/command.ts";
import { commandAvailable } from "../lib/homebrew.ts";
import { CliFailure, fail, runMain } from "../lib/program.ts";

const version = process.env.TIZEN_SDK_VERSION || "10.0";
const home = process.env.HOME || "";
const studioHome = process.env.TIZEN_STUDIO_HOME || join(home, "tizen-studio");
const downloadDir = process.env.TIZEN_DOWNLOAD_DIR || join(home, "Downloads/tizen-install");
const installerName = `web-cli_Tizen_SDK_${version}_macos-64.bin`;
const installerUrl = process.env.TIZEN_INSTALLER_URL || `https://download.tizen.org/sdk/Installer/tizen-sdk_${version}/${installerName}`;
const installerPath = join(downloadDir, installerName);
const packageManager = join(studioHome, "package-manager/package-manager-cli.bin");
const javaTool = process.env.TIZEN_JAVA_TOOL || "java@temurin-21";
const packageProxy = process.env.TIZEN_PACKAGE_PROXY || "direct";
const usage = `usage: scripts/tizen/install.ts [--show-pkgs] [--packages package1,package2]

Environment:
  TIZEN_SDK_VERSION      default: 10.0
  TIZEN_STUDIO_HOME      default: $HOME/tizen-studio
  TIZEN_DOWNLOAD_DIR     default: $HOME/Downloads/tizen-install
  TIZEN_INSTALLER_URL    default: official Tizen SDK CLI installer URL
  TIZEN_PACKAGES         optional comma-separated package list
  TIZEN_DOWNLOADER       default: aria2c when available, otherwise curl
  TIZEN_JAVA_TOOL        mise Java tool, default: java@temurin-21
  TIZEN_PACKAGE_PROXY    package-manager proxy mode, default: direct`;

type Arguments = { readonly showPackages: boolean; readonly packages: string };

const parseArguments = Effect.fn("parseTizenInstallArguments")(function*(args: readonly string[]): Effect.fn.Return<Arguments, CliFailure> {
  let showPackages = false;
  let packages = process.env.TIZEN_PACKAGES || "";
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--show-pkgs") {
      showPackages = true;
    } else if (args[index] === "--packages") {
      const value = args[index + 1];
      if (!value) return yield* fail("--packages requires a comma-separated package list", 2);
      packages = value;
      index += 1;
    } else {
      return yield* fail(`unknown argument: ${args[index]}`, 2);
    }
  }
  return { showPackages, packages };
});

const runRaw = (
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
  output: "capture" | "inherit" | "ignore" = "inherit",
) => runCommand(command, args, { env, stdin: "inherit", output });

const run = (
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
  output: "capture" | "inherit" | "ignore" = "inherit",
) => runChecked(command, args, { env, stdin: "inherit", output });

const executable = Effect.fn("isExecutableFile")(function*(path: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(path).pipe(Effect.option);
  return Option.isSome(info) && info.value.type === "File" && (info.value.mode & 0o111) !== 0;
});

const linkTool = Effect.fn("linkTizenTool")(function*(source: string, target: string) {
  if (!(yield* executable(source))) return;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(target, { force: true });
  yield* fs.symlink(source, target);
  yield* Console.log(`linked ${target} -> ${source}`);
});

const installRosetta = Effect.fn("installTizenRosetta")(function*() {
  if (process.arch !== "arm64") return;
  const installed = yield* runRaw("pkgutil", ["--pkg-info", "com.apple.pkg.RosettaUpdateAuto"], {}, "ignore");
  if (installed.status === 0) {
    yield* Console.log("Rosetta is already installed");
    return;
  }
  yield* Console.log("installing Rosetta for Tizen x86_64 tools");
  yield* run("softwareupdate", ["--install-rosetta", "--agree-to-license"]);
});

const setupJava = Effect.fn("setupTizenJava")(function*() {
  const fs = yield* FileSystem.FileSystem;
  const fallbackMise = "/opt/homebrew/bin/mise";
  const mise = (yield* commandAvailable("mise"))
    ? "mise"
    : (yield* executable(fallbackMise)) ? fallbackMise : undefined;
  if (mise) {
    yield* run(mise, ["install", javaTool]);
    const where = yield* run(mise, ["where", javaTool], {}, "capture");
    const javaHome = where.stdout.trim();
    const env = { JAVA_HOME: javaHome, PATH: `${join(javaHome, "bin")}:${process.env.PATH || ""}` };
    yield* Console.log(`using ${javaTool} at ${javaHome}`);
    yield* run("java", ["-version"], env);
    return env;
  }
  yield* Console.error("mise not found; falling back to system java");
  yield* run("java", ["-version"]);
  return {};
});

const downloadInstaller = Effect.fn("downloadTizenInstaller")(function*(javaEnv: Readonly<Record<string, string>>) {
  const requested = process.env.TIZEN_DOWNLOADER;
  if (requested === "curl") {
    if (!(yield* commandAvailable("curl"))) return yield* fail("missing required command: curl");
    yield* Console.log("downloading with curl resume/retry support");
    yield* run("curl", ["-fL", "-C", "-", "--retry", "20", "--retry-delay", "5", "--retry-all-errors", "-o", installerPath, installerUrl], javaEnv);
    return;
  }
  if (requested === "aria2c" || (yield* commandAvailable("aria2c"))) {
    if (!(yield* commandAvailable("aria2c"))) return yield* fail("missing required command: aria2c");
    yield* Console.log("downloading with aria2c resume/retry support");
    yield* run("aria2c", [
      "--continue=true", "--max-tries=0", "--retry-wait=5", "--timeout=30", "--connect-timeout=30",
      "--summary-interval=30", "--dir", downloadDir, "--out", installerName, installerUrl,
    ], javaEnv);
    return;
  }
  if (!(yield* commandAvailable("curl"))) return yield* fail("missing required command: curl");
  yield* Console.log("aria2c not found; downloading with curl resume/retry support");
  yield* run("curl", ["-fL", "-C", "-", "--retry", "20", "--retry-delay", "5", "--retry-all-errors", "-o", installerPath, installerUrl], javaEnv);
});

const program = Effect.gen(function*() {
  const raw = process.argv.slice(2);
  if (raw.length === 1 && (raw[0] === "-h" || raw[0] === "--help")) {
    yield* Console.log(usage);
    return;
  }
  const args = yield* parseArguments(raw).pipe(Effect.tapError(() => Console.error(usage)));
  if (process.platform !== "darwin") return yield* fail("this installer script is currently macOS-only");
  if (!home) return yield* fail("HOME is required");
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(downloadDir, { recursive: true });
  yield* fs.makeDirectory(join(home, ".local/bin"), { recursive: true });
  yield* installRosetta();
  const javaEnv = yield* setupJava();
  if (!(yield* executable(packageManager))) {
    if (yield* fs.exists(studioHome)) {
      return yield* fail(`Tizen Studio path exists but package manager is missing: ${studioHome}\nmove or remove that directory, then rerun this script`);
    }
    yield* Console.log(`installer: ${installerPath}`);
    yield* downloadInstaller(javaEnv);
    yield* fs.chmod(installerPath, 0o755);
    yield* runRaw("xattr", ["-dr", "com.apple.quarantine", installerPath], javaEnv, "ignore");
    yield* Console.log(`installing Tizen SDK ${version} into ${studioHome}`);
    yield* run(installerPath, ["--accept-license", "--no-java-check", studioHome], javaEnv);
  } else {
    yield* Console.log(`Tizen package manager already exists at ${packageManager}`);
  }
  if (!(yield* executable(packageManager))) return yield* fail(`package manager not found after install: ${packageManager}`);
  yield* linkTool(join(studioHome, "tools/ide/bin/tizen"), join(home, ".local/bin/tizen"));
  yield* linkTool(join(studioHome, "tools/ide/bin/tizen.sh"), join(home, ".local/bin/tizen.sh"));
  yield* linkTool(join(studioHome, "tools/sdb"), join(home, ".local/bin/sdb"));
  yield* linkTool(packageManager, join(home, ".local/bin/package-manager-cli"));
  yield* Console.log("clearing stale Tizen package-manager JDK cache");
  yield* fs.remove(join(home, ".package-manager/jdk"), { recursive: true, force: true });
  if (args.packages) {
    yield* Console.log(`installing Tizen packages: ${args.packages}`);
    yield* run(packageManager, ["install", "--accept-license", "--no-java-check", "--proxy", packageProxy, args.packages], javaEnv);
  }
  yield* Console.log("\nVerifying Tizen tools:");
  yield* run(join(home, ".local/bin/tizen"), ["version"], javaEnv);
  yield* run(join(home, ".local/bin/sdb"), ["version"], javaEnv);
  yield* run(packageManager, ["--help"], javaEnv, "ignore");
  yield* run(packageManager, ["show-info"], javaEnv, "ignore");
  if (args.showPackages) {
    yield* Console.log("\nAvailable packages:");
    yield* Console.error("warning: Samsung package catalog lookup can be slow or hang on extension downloads");
    yield* run(packageManager, ["show-pkgs", "--proxy", packageProxy, "--tree"], javaEnv);
  }
  yield* Console.log("\nTizen SDK install step finished.");
  yield* Console.log("Package catalog lookup is intentionally skipped by default; use --show-pkgs only when needed.");
  yield* Console.log("Next, restore cert/profile state if needed:\n  ./scripts/tizen/restore.ts ~/Desktop/tizen-certs-YYYYMMDDHHMMSS.tar.gz");
}).pipe(
  Effect.provide(CommandRunner.layer),
  Effect.provide(NodeServices.layer),
);

runMain(program);
