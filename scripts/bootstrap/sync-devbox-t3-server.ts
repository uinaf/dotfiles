#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option } from "effect";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner, runCommand } from "../lib/command.ts";
import { defaultBranchFromRemoteHead, dirtyCheckoutReason, unpublishedCheckoutReason } from "../lib/git-checkout.ts";
import { CliFailure, fail, runMain } from "../lib/program.ts";
import {
  parseT3Version,
  shellQuote,
  sshHardeningArguments,
  sshTargetPattern,
  workstationT3Installation,
  type WorkstationT3Installation,
} from "../lib/t3-code.ts";
import { collectT3ServerComparison, type T3ServerComparison } from "../verify/t3-server-version.ts";

export {
  parseT3Version,
  selectWorkstationT3App,
  shellQuote,
  workstationT3Installation,
  workstationT3Version,
  type WorkstationT3Installation,
} from "../lib/t3-code.ts";

export const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const SYNC_BUNDLE_PATHS = [
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

// Exit codes for --check: drift and unavailability are distinct so callers can
// tell "install needed" from "could not decide".
export const exitCodes = { clean: 0, unavailable: 1, drift: 3 } as const;

// Scheduled runs read the target from this owner-only file so the shared
// Topgrade config stays host-neutral. One line: user@host.
export const scheduledTargetFile = ".config/dotfiles/t3-server-target";

// The remote runs the bundle under sudo, so the bundle must come from
// committed history, never from whatever the working tree holds. Interactive
// installs from a dirty checkout need --allow-dirty (HEAD is still what ships).
export type SyncOptions = {
  host: string;
  version?: string;
  check: boolean;
  force: boolean;
  scheduled: boolean;
  allowDirty: boolean;
};

export function parseArguments(args: readonly string[]): SyncOptions {
  let host = "";
  let version: string | undefined;
  let check = false;
  let force = false;
  let scheduled = false;
  let allowDirty = false;

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
      case "--check":
        check = true;
        break;
      case "--force":
        force = true;
        break;
      case "--scheduled":
        scheduled = true;
        break;
      case "--allow-dirty":
        allowDirty = true;
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (scheduled) {
    if (host || version || check || force || allowDirty) throw new Error("--scheduled takes no other arguments");
    return {host: "", check: false, force: false, scheduled: true, allowDirty: false};
  }
  if (check && (force || version || allowDirty)) throw new Error("--check cannot be combined with --force, --version, or --allow-dirty");
  if (!sshTargetPattern.test(host)) {
    throw new Error("--host must be an explicit user@host SSH target");
  }

  return {host, version, check, force, scheduled: false, allowDirty};
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

export const gitArchiveArguments = ["-C", REPO_ROOT, "archive", "--format=tar", "HEAD", "--", ...SYNC_BUNDLE_PATHS] as const;

// Bundle the installer sources from committed HEAD, never the working tree.
export const createSyncBundle = Effect.fn("createSyncBundle")(function*() {
  const result = yield* runCommand("git", gitArchiveArguments);
  if (result.status !== 0) {
    return yield* fail(`could not bundle T3 Code installer sources from HEAD: ${result.stderr.trim()}`);
  }
  return result.stdoutBytes ?? new Uint8Array(Buffer.from(result.stdout, "binary"));
});

export type CheckoutReadiness = {
  // undefined when the bundled paths have no uncommitted changes.
  readonly dirty: string | undefined;
  // undefined when HEAD is the default branch checked out at origin's tip.
  readonly unpublished: string | undefined;
};

// Inspect the checkout the bundle comes from. Mirrors converge.ts: clean,
// default branch, exactly at origin's tip.
export const inspectCheckout = Effect.fn("inspectCheckout")(function*() {
  const git = (...args: readonly string[]) => runCommand("git", ["-C", REPO_ROOT, ...args]).pipe(
    Effect.map((result) => (result.status === 0 ? result.stdout : "")),
  );
  const status = yield* runCommand("git", ["-C", REPO_ROOT, "status", "--porcelain", "--", ...SYNC_BUNDLE_PATHS]);
  if (status.status !== 0) return yield* fail(`could not inspect the dotfiles checkout: ${status.stderr.trim()}`);
  const remoteHead = yield* git("symbolic-ref", "refs/remotes/origin/HEAD");
  const branch = defaultBranchFromRemoteHead(remoteHead);
  const position = {
    headRef: yield* git("symbolic-ref", "HEAD"),
    remoteHead,
    head: yield* git("rev-parse", "HEAD"),
    remoteTip: branch ? yield* git("rev-parse", `refs/remotes/origin/${branch}`) : "",
  };
  return {
    dirty: dirtyCheckoutReason(status.stdout),
    unpublished: unpublishedCheckoutReason(position),
  } satisfies CheckoutReadiness;
});

// A scheduled install refuses any unpublished source; an interactive one
// refuses a dirty tree unless --allow-dirty acknowledges that HEAD ships.
export function checkoutRefusal(readiness: CheckoutReadiness, options: Pick<SyncOptions, "scheduled" | "allowDirty">): string | undefined {
  if (options.scheduled) {
    const reason = readiness.dirty ?? readiness.unpublished;
    return reason ? `scheduled sync refuses an unpublished checkout: ${reason}` : undefined;
  }
  if (readiness.dirty && !options.allowDirty) {
    return `${readiness.dirty}; commit them, or pass --allow-dirty to install committed HEAD anyway`;
  }
  return undefined;
}

// The remote install runs pnpm and the daemon installer; bound it so a hung
// transport or a stuck sudo prompt cannot stall the update pass forever.
export const installTimeoutMs = 15 * 60_000;

export function installSshArguments(host: string, version: string): readonly string[] {
  const command = [
    "/bin/bash -c",
    shellQuote(remoteUpdate),
    "--",
    shellQuote(version),
  ].join(" ");
  return [...sshHardeningArguments, host, command];
}

export type SyncDependencies = {
  readonly detectWorkstation: () => WorkstationT3Installation;
};

const liveDependencies: SyncDependencies = {
  detectWorkstation: workstationT3Installation,
};

export type SyncAction = "checked" | "unchanged" | "installed" | "skipped";

export type SyncReport = {
  schema_version: 1;
  target: string;
  action: SyncAction;
  requested_version: string | null;
  comparison: T3ServerComparison | null;
  reason: string | null;
};

function report(
  target: string,
  action: SyncAction,
  requested: string | null,
  comparison: T3ServerComparison | null,
  reason: string | null = null,
): SyncReport {
  return {schema_version: 1, target, action, requested_version: requested, comparison, reason};
}

export function checkExitCode(comparison: T3ServerComparison): number {
  if (comparison.status === "incomplete") return exitCodes.unavailable;
  return comparison.versions_match ? exitCodes.clean : exitCodes.drift;
}

// Decide whether an install must run. Only a healthy service already at the
// requested version is left alone; an unloaded or unhealthy service at the
// same version still reinstalls so the remote verification restarts it.
export function installRequired(
  comparison: T3ServerComparison,
  requested: string,
  force: boolean,
): {install: boolean; reason: string} {
  if (force) return {install: true, reason: "forced"};
  if (comparison.status === "incomplete") {
    return {install: false, reason: comparison.error?.message ?? "the devbox could not be inspected"};
  }
  if (comparison.server?.version !== requested) {
    return {install: true, reason: `server runs ${comparison.server?.version ?? "unknown"}, expected ${requested}`};
  }
  if (comparison.server.service_state !== "loaded" || comparison.server.health !== "healthy") {
    return {install: true, reason: `server is at ${requested} but ${comparison.server.service_state} and ${comparison.server.health}`};
  }
  return {install: false, reason: `server already runs ${requested} and is healthy`};
}

const install = Effect.fn("installDevboxT3Server")(function*(
  host: string,
  version: string,
  options: Pick<SyncOptions, "scheduled" | "allowDirty">,
) {
  const runner = yield* CommandRunner;
  const refusal = checkoutRefusal(yield* inspectCheckout(), options);
  if (refusal) return yield* fail(refusal);
  const bundle = yield* createSyncBundle();
  yield* Console.log(`Syncing T3 Code ${version} to ${host}.`);
  const result = yield* runner.run("ssh", installSshArguments(host, version), {
    stdin: bundle,
    output: "inherit",
    timeoutMs: installTimeoutMs,
  }).pipe(Effect.mapError((error) => new CliFailure({exitCode: 1, message: error.message})));
  if (result.status !== 0) {
    return yield* fail(`${host} T3 Code update failed with status ${result.status}`, result.status || 1);
  }
  yield* Console.log(`T3 Code ${version} is healthy on ${host}.`);
});

// Compare first; install only on drift, --force, or an unhealthy service.
// Only a transport failure is a "skipped" report: the devbox may simply be
// off. A workstation or remote structure error is a real defect and fails.
export const syncDevboxT3Server = Effect.fn("syncDevboxT3Server")(function*(
  options: SyncOptions,
  dependencies: SyncDependencies = liveDependencies,
) {
  const comparison = yield* collectT3ServerComparison(options.host, dependencies.detectWorkstation);
  if (options.check) return report(options.host, "checked", comparison.workstation?.version ?? null, comparison);

  const requested = options.version ?? comparison.workstation?.version;
  if (!requested) {
    return yield* fail(comparison.error?.message ?? "workstation version unavailable");
  }
  const decision = installRequired(comparison, requested, options.force);
  if (!decision.install) {
    if (comparison.status !== "incomplete") return report(options.host, "unchanged", requested, comparison, decision.reason);
    if (comparison.error?.kind !== "transport") {
      return yield* fail(`${options.host}: ${decision.reason} (${comparison.error?.code ?? "unknown"})`);
    }
    return report(options.host, "skipped", requested, comparison, decision.reason);
  }
  yield* install(options.host, requested, options);
  return report(options.host, "installed", requested, comparison, decision.reason);
});

// Scheduled entry for the workstation updater: a missing target file or an
// unreachable devbox is a reported skip so the rest of the update pass
// continues. An invalid target file, a workstation app that cannot be
// inspected, an invalid remote service layout, an unpublished checkout, or
// an install failure fails the step.
export const readScheduledTarget = Effect.fn("readScheduledTarget")(function*(home: string, uid: number | undefined) {
  const fs = yield* FileSystem.FileSystem;
  const path = join(home, scheduledTargetFile);
  if (!(yield* fs.exists(path))) return undefined;
  const link = yield* fs.readLink(path).pipe(Effect.option);
  const info = yield* fs.stat(path);
  if (Option.isSome(link) || info.type !== "File" || (info.mode & 0o077) !== 0 ||
      (uid !== undefined && Option.getOrUndefined(info.uid) !== uid)) {
    return yield* fail(`${path} must be an owner-only regular file`);
  }
  const target = (yield* fs.readFileString(path)).trim();
  if (!sshTargetPattern.test(target)) return yield* fail(`${path} must contain one user@host SSH target`);
  return target;
});

export function usageText(): string {
  return `Usage:
  scripts/bootstrap/sync-devbox-t3-server.ts --host USER@HOST [--version t3@0.0.35] [--force] [--allow-dirty]
  scripts/bootstrap/sync-devbox-t3-server.ts --host USER@HOST --check
  scripts/bootstrap/sync-devbox-t3-server.ts --scheduled

Without --version, reads the installed T3 Code app version. Installs only when
the devbox differs from that version, is unloaded or unhealthy, or --force is
set; a matching healthy server is never restarted. --check compares without
changing either machine: exit ${exitCodes.clean} when equal, ${exitCodes.drift} on drift, ${exitCodes.unavailable} when the
comparison is unavailable. --scheduled reads USER@HOST from
~/${scheduledTargetFile} and reports a skip when it is missing or unreachable;
any other failure fails the step.
The installer sources ship from committed HEAD of this checkout. A dirty tree
is refused unless --allow-dirty; --scheduled also requires HEAD to be the
default branch at origin's tip.
The remote server uses the SSH user's home as its working directory.`;
}

function summary(result: SyncReport): string {
  const local = result.comparison?.workstation?.version ?? "unknown";
  const remote = result.comparison?.server?.version ?? "unknown";
  return `T3 Code ${result.action}: workstation ${local}, ${result.target} ${remote}${result.reason ? ` (${result.reason})` : ""}`;
}

const program = Effect.gen(function*() {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    yield* Console.log(usageText());
    return;
  }
  const options = yield* Effect.try({
    try: () => parseArguments(args),
    catch: (error) => new CliFailure({
      exitCode: 2,
      message: `${error instanceof Error ? error.message : String(error)}\n${usageText()}`,
    }),
  });

  if (options.scheduled) {
    const target = yield* readScheduledTarget(process.env.HOME || "", process.getuid?.());
    if (!target) {
      yield* Console.log(`T3 Code skipped: no ~/${scheduledTargetFile} on this workstation.`);
      return;
    }
    const result = yield* syncDevboxT3Server({...options, host: target});
    yield* Console.log(summary(result));
    return;
  }

  const result = yield* syncDevboxT3Server(options);
  if (options.check) {
    yield* Effect.sync(() => {
      process.stdout.write(`${JSON.stringify(result.comparison)}\n`);
      process.exitCode = checkExitCode(result.comparison!);
    });
    return;
  }
  yield* Console.log(summary(result));
  if (result.action === "skipped") return yield* fail(result.reason ?? "the devbox could not be reached");
}).pipe(
  Effect.provide(CommandRunner.layer),
  Effect.provide(NodeServices.layer),
);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMain(program);
}
