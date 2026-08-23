#!/usr/bin/env node

import {execFileSync, spawnSync} from "node:child_process";
import {existsSync} from "node:fs";
import {fileURLToPath} from "node:url";

const NIGHTLY_APP_PLIST =
  "/Applications/T3 Code (Nightly).app/Contents/Info.plist";

export type SyncOptions = {
  host: string;
  remoteDotfilesDirectory: string;
  version?: string;
  workspaceDirectory: string;
};

export function parseT3NightlyVersion(input: string): string {
  const packageSpec = input.trim().replace(/^npx\s+/, "");
  const version = packageSpec.startsWith("t3@")
    ? packageSpec.slice("t3@".length)
    : packageSpec;
  if (!/^0\.0\.\d+-nightly\.\d{8}\.\d+$/.test(version)) {
    throw new Error(`expected an exact T3 nightly version, got: ${input}`);
  }
  return version;
}

export function parseArguments(args: readonly string[]): SyncOptions {
  let host = "";
  let remoteDotfilesDirectory = "";
  let version: string | undefined;
  let workspaceDirectory = "";

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    switch (argument) {
      case "--host":
        if (!value) throw new Error("--host requires a value");
        host = value;
        index += 1;
        break;
      case "--remote-dotfiles":
        if (!value) throw new Error("--remote-dotfiles requires a value");
        remoteDotfilesDirectory = value;
        index += 1;
        break;
      case "--version":
        if (!value) throw new Error("--version requires a value");
        version = parseT3NightlyVersion(value);
        index += 1;
        break;
      case "--workspace":
        if (!value) throw new Error("--workspace requires a value");
        workspaceDirectory = value;
        index += 1;
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(host)) {
    throw new Error("--host must be an explicit user@host SSH target");
  }
  if (!workspaceDirectory.startsWith("/")) {
    throw new Error("--workspace must be an absolute remote path");
  }
  if (
    remoteDotfilesDirectory !== "" &&
    !remoteDotfilesDirectory.startsWith("/")
  ) {
    throw new Error("--remote-dotfiles must be an absolute remote path");
  }

  return {host, remoteDotfilesDirectory, version, workspaceDirectory};
}

export function workstationT3NightlyVersion(): string {
  if (!existsSync(NIGHTLY_APP_PLIST)) {
    throw new Error(
      `missing T3 Code Nightly app; pass --version explicitly: ${NIGHTLY_APP_PLIST}`,
    );
  }
  const version = execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleShortVersionString", NIGHTLY_APP_PLIST],
    {encoding: "utf8"},
  );
  return parseT3NightlyVersion(version);
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const remoteUpdate = String.raw`set -euo pipefail
version="$1"
workspace_directory="$2"
remote_dotfiles_directory="$3"
if [ -z "$remote_dotfiles_directory" ]; then
  remote_dotfiles_directory="$(dirname "$workspace_directory")/dotfiles"
fi

cd "$remote_dotfiles_directory"
if [ -n "$(git status --short)" ]; then
  printf 'FAILED: dirty dotfiles checkout on %s\n' "$(hostname)" >&2
  exit 1
fi
git pull --ff-only

./scripts/secrets/sops-devbox-sudo.sh -- \
  ./scripts/bootstrap/install-devbox-service-daemons.sh \
  --user "$(id -un)" \
  --t3-code \
  --t3-version "$version" \
  --t3-working-directory "$workspace_directory"

./scripts/bootstrap/install-devbox-service-daemons.sh \
  --user "$(id -un)" \
  --t3-code \
  --t3-version "$version" \
  --t3-working-directory "$workspace_directory" \
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

export function syncDevboxT3Server(options: SyncOptions): void {
  const version = options.version ?? workstationT3NightlyVersion();
  const remoteCommand = [
    "/bin/bash -s --",
    shellQuote(version),
    shellQuote(options.workspaceDirectory),
    shellQuote(options.remoteDotfilesDirectory),
  ].join(" ");

  process.stdout.write(`Syncing T3 Code ${version} to ${options.host}.\n`);
  const result = spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", options.host, remoteCommand],
    {input: remoteUpdate, stdio: ["pipe", "inherit", "inherit"]},
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
    --workspace /absolute/remote/workspace \\
    [--remote-dotfiles /absolute/remote/dotfiles] \\
    [--version t3@0.0.34-nightly.20260823.1166]

Without --version, reads the installed T3 Code Nightly app version.
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
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
