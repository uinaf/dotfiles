#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import { collectMaintenanceSnapshot, parseBrewBacklog, type CommandRunner, type MaintenanceContext } from "./check.ts";

const profileConfig = {
  capabilities: {
    developer: true,
    workload: false,
    sharedHomebrew: false,
    requiresSopsIdentity: false,
    devbox: false,
    workstation: true,
    personal: false,
    githubAppAuth: false,
  },
  brewfiles: ["Brewfile"],
  runtimeGroup: "developer" as const,
  skillLayers: ["developer" as const],
  installSteps: ["apply-dotfiles", "install-runtimes"],
};

function context(): MaintenanceContext {
  return {
    cwd: "/fixture/repo",
    env: { HOME: "/fixture/home", USER: "fixture" },
    home: "/fixture/home",
    hostname: "fixture-host",
    ownsHomebrew: false,
    platform: "linux",
    profile: "workstation",
    profileConfig,
    repoRoot: "/fixture/repo",
    user: "fixture",
    verify: false,
  };
}

function result(stdout: string, status = 0) {
  return { status, stdout, stderr: "" };
}

test("Homebrew backlog parsing keeps exact installed and current versions", () => {
  assert.deepEqual(
    parseBrewBacklog(JSON.stringify({
      formulae: [{ name: "jq", installed_versions: ["1.7"], current_version: "1.8" }],
      casks: [{ name: "example", installed_versions: ["1.0"], current_version: "2.0" }],
    })),
    {
      formulae: [{ name: "jq", installed_versions: ["1.7"], current_version: "1.8" }],
      casks: [{ name: "example", installed_versions: ["1.0"], current_version: "2.0" }],
    },
  );
});

test("maintenance probes run concurrently and summarize package drift", async () => {
  let active = 0;
  let maxActive = 0;
  const runner: CommandRunner = async (command, args) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    if (command === "df") return result("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 100 40 60 40% /\n");
    if (command === "tailscale" && args[0] === "status") return result(JSON.stringify({ BackendState: "Running", MagicDNSSuffix: "fixture.ts.net", Self: { Online: true }, Peer: {} }));
    if (command === "mise" || (command === "npm" && args[0] === "outdated")) return result("{}");
    if (command === "git") return result("");
    if (command.endsWith("bootstrap.sh")) return result("bootstrap verification ok\n");
    return result("1.0.0\n");
  };
  const snapshot = await collectMaintenanceSnapshot({ ...context(), profileConfig: { ...profileConfig, skillLayers: [] } }, runner);
  assert.ok(maxActive > 1);
  assert.equal(snapshot.summary.required_failures, 0);
  assert.equal(snapshot.summary.backlog_count, 0);
  assert.equal(snapshot.summary.status, "clean");
});

test("missing required commands make the snapshot incomplete without throwing", async () => {
  const runner: CommandRunner = async () => ({
    status: 127,
    stdout: "",
    stderr: "",
    error: Object.assign(new Error("missing"), { code: "ENOENT" }),
  });
  const snapshot = await collectMaintenanceSnapshot({ ...context(), profileConfig: { ...profileConfig, skillLayers: [] } }, runner);
  assert.equal(snapshot.summary.status, "incomplete");
  assert.ok(snapshot.summary.required_failures > 0);
  assert.equal(snapshot.probes.system?.status, "unavailable");
});
