#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, Schema } from "effect";
import { fileURLToPath } from "node:url";
import { CommandRunner, type CommandResult } from "../lib/command.ts";
import { CliFailure, runMain } from "../lib/program.ts";
import {
  shellQuote,
  workstationT3Installation,
  type WorkstationT3Installation,
} from "../bootstrap/sync-devbox-t3-server.ts";

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const Version = Schema.String.pipe(Schema.check(Schema.isPattern(exactVersion)));
const RemoteErrorCode = Schema.Literals([
  "identity_unavailable",
  "invalid_identity",
  "missing_namespace",
  "invalid_namespace",
  "missing_service_plist",
  "invalid_service_plist",
  "invalid_service_entrypoint",
  "invalid_server_version",
  "missing_server_entrypoint",
]);
const RemoteSuccess = Schema.Struct({
  schema_version: Schema.Literal(1),
  status: Schema.Literal("ok"),
  version: Version,
  service_state: Schema.Literals(["loaded", "unloaded"]),
  health: Schema.Literals(["healthy", "unhealthy"]),
});
const RemoteFailure = Schema.Struct({
  schema_version: Schema.Literal(1),
  status: Schema.Literal("error"),
  error_code: RemoteErrorCode,
});
const RemoteInspection = Schema.Union([RemoteSuccess, RemoteFailure]);

type RemoteInspection = typeof RemoteInspection.Type;
type ErrorKind = "workstation" | "transport" | "structure";

export type T3ServerComparison = {
  schema_version: 1;
  target: string;
  status: "clean" | "attention" | "incomplete";
  workstation: WorkstationT3Installation | null;
  server: {
    version: string;
    service_state: "loaded" | "unloaded";
    health: "healthy" | "unhealthy";
  } | null;
  versions_match: boolean | null;
  error: {
    kind: ErrorKind;
    code: string;
    message: string;
  } | null;
};

export type T3ServerOptions = {
  host: string;
};

const remoteErrorMessages = {
  identity_unavailable: "the remote identity could not be inspected",
  invalid_identity: "the remote identity is outside the service label contract",
  missing_namespace: "the remote launchd namespace contract is missing",
  invalid_namespace: "the remote launchd namespace contract is invalid",
  missing_service_plist: "the remote T3 Code service plist is missing",
  invalid_service_plist: "the remote T3 Code service plist cannot be read",
  invalid_service_entrypoint: "the remote T3 Code service entrypoint is outside the managed layout",
  invalid_server_version: "the remote T3 Code service has an invalid version",
  missing_server_entrypoint: "the remote T3 Code server entrypoint is missing",
} as const satisfies Record<typeof RemoteErrorCode.Type, string>;

export const remoteInspection = String.raw`set -u
emit_error() {
  printf '{"schema_version":1,"status":"error","error_code":"%s"}\n' "$1"
  exit 0
}

user="$(id -un 2>/dev/null)" || emit_error "identity_unavailable"
[[ "$user" =~ ^[A-Za-z0-9._-]+$ ]] || emit_error "invalid_identity"

namespace_file="$HOME/.config/dotfiles/launchd-namespace"
[ -f "$namespace_file" ] && [ ! -L "$namespace_file" ] && [ -r "$namespace_file" ] || emit_error "missing_namespace"
namespace="$(cat "$namespace_file" 2>/dev/null)" || emit_error "invalid_namespace"
[[ "$namespace" =~ ^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$ ]] || emit_error "invalid_namespace"

label="$namespace.t3-code.$user"
plist="/Library/LaunchDaemons/$label.plist"
[ -f "$plist" ] && [ ! -L "$plist" ] && [ -r "$plist" ] || emit_error "missing_service_plist"
entrypoint="$(/usr/bin/plutil -extract ProgramArguments.1 raw "$plist" 2>/dev/null)" || emit_error "invalid_service_plist"

prefix="$HOME/.local/share/t3-code/service/"
suffix="/node_modules/t3/dist/bin.mjs"
case "$entrypoint" in
  "$prefix"*"$suffix") ;;
  *) emit_error "invalid_service_entrypoint" ;;
esac
service_directory="$(/usr/bin/dirname "$(/usr/bin/dirname "$(/usr/bin/dirname "$(/usr/bin/dirname "$entrypoint")")")")"
version="$(/usr/bin/basename "$service_directory")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]] || emit_error "invalid_server_version"
expected_entrypoint="$prefix$version$suffix"
[ "$entrypoint" = "$expected_entrypoint" ] || emit_error "invalid_service_entrypoint"
[ -f "$entrypoint" ] && [ ! -L "$entrypoint" ] && [ -r "$entrypoint" ] || emit_error "missing_server_entrypoint"

service_state="unloaded"
if /bin/launchctl print "system/$label" >/dev/null 2>&1; then
  service_state="loaded"
fi
health="unhealthy"
if /usr/bin/curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3773/ >/dev/null 2>&1; then
  health="healthy"
fi

printf '{"schema_version":1,"status":"ok","version":"%s","service_state":"%s","health":"%s"}\n' \
  "$version" "$service_state" "$health"
`;

const usageText = `Usage:
  scripts/verify/t3-server-version.ts --host USER@HOST

Inspects one explicit remote T3 Code server without changing workstation or
server state. Writes one structured JSON result to standard output.
`;

export function parseArguments(args: readonly string[]): T3ServerOptions {
  if (args.length !== 2 || args[0] !== "--host" || !args[1]) {
    throw new Error("expected --host USER@HOST");
  }
  const host = args[1];
  if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(host)) {
    throw new Error("--host must be an explicit user@host SSH target");
  }
  return {host};
}

export function sshArguments(host: string): readonly string[] {
  const command = ["/bin/bash -c", shellQuote(remoteInspection), "--"].join(" ");
  return [
    "-o", "BatchMode=yes",
    "-o", "ClearAllForwardings=yes",
    "-o", "ConnectionAttempts=1",
    "-o", "ConnectTimeout=10",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "RequestTTY=no",
    "-o", "ServerAliveCountMax=2",
    "-o", "ServerAliveInterval=5",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "UpdateHostKeys=no",
    host,
    command,
  ];
}

function incomplete(
  target: string,
  workstation: WorkstationT3Installation | null,
  kind: ErrorKind,
  code: string,
  message: string,
): T3ServerComparison {
  return {
    schema_version: 1,
    target,
    status: "incomplete",
    workstation,
    server: null,
    versions_match: null,
    error: {kind, code, message},
  };
}

export function workstationFailure(target: string, error: unknown): T3ServerComparison {
  const message = error instanceof Error ? error.message : String(error);
  return incomplete(
    target,
    null,
    "workstation",
    "workstation_inspection_failed",
    message || "the workstation T3 Code app could not be inspected",
  );
}

export function parseRemoteInspection(stdout: string): RemoteInspection {
  const payload: unknown = JSON.parse(stdout);
  return Schema.decodeUnknownSync(RemoteInspection, {
    errors: "all",
    onExcessProperty: "error",
  })(payload);
}

export function evaluateRemoteInspection(
  target: string,
  workstation: WorkstationT3Installation,
  result: CommandResult,
): T3ServerComparison {
  if (result.status !== 0) {
    return incomplete(
      target,
      workstation,
      "transport",
      "ssh_failed",
      `SSH inspection exited ${result.status}`,
    );
  }

  let inspection: RemoteInspection;
  try {
    inspection = parseRemoteInspection(result.stdout);
  } catch {
    return incomplete(
      target,
      workstation,
      "structure",
      "invalid_remote_protocol",
      "the remote inspection returned an invalid protocol payload",
    );
  }
  if (inspection.status === "error") {
    return incomplete(
      target,
      workstation,
      "structure",
      inspection.error_code,
      remoteErrorMessages[inspection.error_code],
    );
  }

  const versionsMatch = inspection.version === workstation.version;
  const healthy = inspection.service_state === "loaded" && inspection.health === "healthy";
  return {
    schema_version: 1,
    target,
    status: versionsMatch && healthy ? "clean" : "attention",
    workstation,
    server: {
      version: inspection.version,
      service_state: inspection.service_state,
      health: inspection.health,
    },
    versions_match: versionsMatch,
    error: null,
  };
}

export const collectT3ServerComparison = Effect.fn("collectT3ServerComparison")(
  function*(target: string) {
    const workstationResult = yield* Effect.try({
      try: () => workstationT3Installation(),
      catch: (error) => error,
    }).pipe(
      Effect.map((value) => ({ok: true, value}) as const),
      Effect.catch((error) => Effect.succeed({ok: false as const, error})),
    );
    if (!workstationResult.ok) return workstationFailure(target, workstationResult.error);

    const runner = yield* CommandRunner;
    const remoteResult = yield* runner.run("ssh", sshArguments(target)).pipe(
      Effect.map((value) => ({ok: true, value}) as const),
      Effect.catch(() => Effect.succeed({ok: false as const})),
    );
    if (!remoteResult.ok) {
      return incomplete(
        target,
        workstationResult.value,
        "transport",
        "ssh_unavailable",
        "SSH inspection could not start",
      );
    }
    return evaluateRemoteInspection(target, workstationResult.value, remoteResult.value);
  },
);

const program = Effect.gen(function*() {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    yield* Console.log(usageText.trimEnd());
    return;
  }
  const options = yield* Effect.try({
    try: () => parseArguments(args),
    catch: (error) => new CliFailure({
      exitCode: 2,
      message: `${error instanceof Error ? error.message : String(error)}\n${usageText.trimEnd()}`,
    }),
  });
  const comparison = yield* collectT3ServerComparison(options.host);
  yield* Effect.sync(() => {
    process.stdout.write(`${JSON.stringify(comparison)}\n`);
    if (comparison.status === "incomplete") process.exitCode = 1;
  });
}).pipe(
  Effect.provide(CommandRunner.layer),
  Effect.provide(NodeServices.layer),
);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMain(program);
}
