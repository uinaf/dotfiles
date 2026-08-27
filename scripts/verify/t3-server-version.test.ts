import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateRemoteInspection,
  parseArguments,
  parseRemoteInspection,
  remoteInspection,
  sshArguments,
  workstationFailure,
} from "./t3-server-version.ts";

const workstation = {app: "T3 Code (Example).app", version: "0.0.35"};
const target = "example@example-devbox";

function result(stdout: string, status = 0) {
  return {status, stdout, stderr: ""};
}

test("requires one explicit portable SSH target", () => {
  assert.deepEqual(parseArguments(["--host", target]), {host: target});
  assert.throws(() => parseArguments(["--host", "example-devbox"]), /explicit user@host/);
  assert.throws(() => parseArguments(["--host", target, "--version", "0.0.35"]), /expected --host/);
});

test("SSH inspection disables client-side writes and forwarding", () => {
  const args = sshArguments(target);
  assert.deepEqual(args.slice(-2)[0], target);
  assert.ok(args.includes("BatchMode=yes"));
  assert.ok(args.includes("ClearAllForwardings=yes"));
  assert.ok(args.includes("StrictHostKeyChecking=yes"));
  assert.ok(args.includes("UpdateHostKeys=no"));
  assert.ok(args.includes("ControlMaster=no"));
});

test("remote inspection is read-only", () => {
  assert.doesNotMatch(remoteInspection, /\b(?:install|kickstart|bootstrap|bootout|enable|disable|rm|mv|cp|chmod|chown|mkdir|touch)\b/);
  assert.match(remoteInspection, /launchctl print/);
  assert.match(remoteInspection, /curl --fail/);
});

test("validates the strict remote protocol", () => {
  assert.deepEqual(
    parseRemoteInspection('{"schema_version":1,"status":"ok","version":"0.0.35","service_state":"loaded","health":"healthy"}\n'),
    {schema_version: 1, status: "ok", version: "0.0.35", service_state: "loaded", health: "healthy"},
  );
  assert.throws(
    () => parseRemoteInspection('{"schema_version":1,"status":"ok","version":"latest","service_state":"loaded","health":"healthy"}'),
  );
  assert.throws(
    () => parseRemoteInspection('{"schema_version":1,"status":"ok","version":"0.0.35","service_state":"loaded","health":"healthy","extra":true}'),
  );
});

test("reports matching healthy versions as clean", () => {
  assert.deepEqual(
    evaluateRemoteInspection(
      target,
      workstation,
      result('{"schema_version":1,"status":"ok","version":"0.0.35","service_state":"loaded","health":"healthy"}\n'),
    ),
    {
      schema_version: 1,
      target,
      status: "clean",
      workstation,
      server: {version: "0.0.35", service_state: "loaded", health: "healthy"},
      versions_match: true,
      error: null,
    },
  );
});

test("reports version drift and service health without failing inspection", () => {
  const mismatch = evaluateRemoteInspection(
    target,
    workstation,
    result('{"schema_version":1,"status":"ok","version":"0.0.34","service_state":"loaded","health":"healthy"}'),
  );
  assert.equal(mismatch.status, "attention");
  assert.equal(mismatch.versions_match, false);
  assert.equal(mismatch.error, null);

  const unhealthy = evaluateRemoteInspection(
    target,
    workstation,
    result('{"schema_version":1,"status":"ok","version":"0.0.35","service_state":"unloaded","health":"unhealthy"}'),
  );
  assert.equal(unhealthy.status, "attention");
  assert.equal(unhealthy.versions_match, true);
  assert.deepEqual(unhealthy.server, {version: "0.0.35", service_state: "unloaded", health: "unhealthy"});
});

test("distinguishes transport, structure, and workstation failures", () => {
  const transport = evaluateRemoteInspection(target, workstation, result("", 255));
  assert.equal(transport.status, "incomplete");
  assert.equal(transport.error?.kind, "transport");
  assert.equal(transport.error?.code, "ssh_failed");

  const structure = evaluateRemoteInspection(
    target,
    workstation,
    result('{"schema_version":1,"status":"error","error_code":"missing_service_plist"}'),
  );
  assert.equal(structure.status, "incomplete");
  assert.equal(structure.error?.kind, "structure");
  assert.equal(structure.error?.code, "missing_service_plist");

  const invalid = evaluateRemoteInspection(target, workstation, result("login banner"));
  assert.equal(invalid.error?.code, "invalid_remote_protocol");

  const local = workstationFailure(target, new Error("missing T3 Code app"));
  assert.equal(local.status, "incomplete");
  assert.equal(local.workstation, null);
  assert.equal(local.error?.kind, "workstation");
});
