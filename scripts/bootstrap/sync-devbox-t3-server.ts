#!/usr/bin/env node

import {execFileSync, spawnSync} from "node:child_process";
import { Effect } from "effect";
import {readdirSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import { runMain } from "../lib/program.ts";

const APPLICATIONS_DIRECTORY = "/Applications";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SYNC_BUNDLE_PATHS = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "scripts/bootstrap/install-devbox-service-daemons.ts",
  "scripts/lib/command.ts",
  "scripts/lib/launchd.ts",
  "scripts/lib/program.ts",
  "scripts/lib/sudo-age-askpass.sh",
  "scripts/secrets/sops-devbox-sudo.ts",
] as const;

export type SyncOptions = {
  host: string;
  version?: string;
};

export function parseT3Version(input: string): string {
  const packageSpec = input.trim().replace(/^npx\s+/, "");
  const version = packageSpec.startsWith("t3@")
    ? packageSpec.slice("t3@".length)
    : packageSpec;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`expected an exact T3 version, got: ${input}`);
  }
  return version;
}

export function parseArguments(args: readonly string[]): SyncOptions {
  let host = "";
  let version: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    switch (argument) {
      case "--host":
        if (!value) throw new Error("--host requires a value");
        host = value;
        index += 1;
        break;
      case "--version":
        if (!value) throw new Error("--version requires a value");
        version = parseT3Version(value);
        index += 1;
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(host)) {
    throw new Error("--host must be an explicit user@host SSH target");
  }

  return {host, version};
}

export function selectWorkstationT3App(appNames: readonly string[]): string {
  const matches = appNames.filter((name) => /^T3 Code(?: \([^)]+\))?\.app$/.test(name));
  if (matches.includes("T3 Code.app")) return "T3 Code.app";
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error("missing T3 Code app; pass --version explicitly");
  throw new Error(`multiple T3 Code apps found; pass --version explicitly: ${matches.sort().join(", ")}`);
}

export type WorkstationT3Installation = {
  app: string;
  version: string;
};

export function workstationT3Installation(
  applicationsDirectory = APPLICATIONS_DIRECTORY,
): WorkstationT3Installation {
  const app = selectWorkstationT3App(readdirSync(applicationsDirectory));
  const plist = join(applicationsDirectory, app, "Contents/Info.plist");
  const version = execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleShortVersionString", plist],
    {encoding: "utf8"},
  );
  return {app, version: parseT3Version(version)};
}

export function workstationT3Version(applicationsDirectory = APPLICATIONS_DIRECTORY): string {
  return workstationT3Installation(applicationsDirectory).version;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export const remoteUpdate = String.raw`set -euo pipefail
version="$1"
bundle_dir="$(mktemp -d -t dotfiles-t3-sync)"
cleanup() {
  case "$bundle_dir" in
    */dotfiles-t3-sync.*) rm -rf "$bundle_dir" ;;
  esac
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
tar -xf - -C "$bundle_dir"
cd "$bundle_dir"
corepack pnpm install --frozen-lockfile --prod

node ./scripts/secrets/sops-devbox-sudo.ts -- \
  node ./scripts/bootstrap/install-devbox-service-daemons.ts \
  --user "$(id -un)" \
  --t3-code \
  --t3-version "$version"

node ./scripts/bootstrap/install-devbox-service-daemons.ts \
  --user "$(id -un)" \
  --t3-code \
  --t3-version "$version" \
  --check

namespace="$(cat "$HOME/.config/dotfiles/launchd-namespace")"
label="$namespace.t3-code.$(id -un)"
plist="/Library/LaunchDaemons/$label.plist"
expected_entrypoint="$HOME/.local/share/t3-code/service/$version/node_modules/t3/dist/bin.mjs"
installed_entrypoint="$(plutil -extract ProgramArguments.1 raw "$plist")"
[ "$installed_entrypoint" = "$expected_entrypoint" ] || {
  printf 'FAILED: %s uses %s, expected %s\n' \
    "$label" "$installed_entrypoint" "$expected_entrypoint" >&2
  exit 1
}
launchctl print "system/$label" >/dev/null
curl --fail --silent --show-error --max-time 5 \
  http://127.0.0.1:3773/ >/dev/null
printf 'verified %s on %s\n' "$version" "$(hostname)"
`;

export function createSyncBundle(): Buffer {
  const result = spawnSync("tar", ["-cf", "-", ...SYNC_BUNDLE_PATHS], {
    cwd: REPO_ROOT,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `could not bundle T3 Code installer sources: ${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout;
}

export function syncDevboxT3Server(options: SyncOptions): void {
  const version = options.version ?? workstationT3Version();
  const remoteCommand = [
    "/bin/bash -c",
    shellQuote(remoteUpdate),
    "--",
    shellQuote(version),
  ].join(" ");
  const bundle = createSyncBundle();

  process.stdout.write(`Syncing T3 Code ${version} to ${options.host}.\n`);
  const result = spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", options.host, remoteCommand],
    {input: bundle, stdio: ["pipe", "inherit", "inherit"]},
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${options.host} T3 Code update failed with status ${result.status ?? "unknown"}`,
    );
  }
  process.stdout.write(`T3 Code ${version} is healthy on ${options.host}.\n`);
}

function usage(): void {
  process.stdout.write(`Usage:
  scripts/bootstrap/sync-devbox-t3-server.ts \\
    --host USER@HOST \\
    [--version t3@0.0.35]

Without --version, reads the installed T3 Code app version. The remote
server uses the SSH user's home as its working directory.
`);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args[0] === "--help" || args[0] === "-h") {
    usage();
    return;
  }
  syncDevboxT3Server(parseArguments(args));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMain(Effect.sync(main));
}
