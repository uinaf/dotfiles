#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import type { ProfileConfig } from "../profiles/model.ts";
import { collectMaintenanceSnapshot, parseBrewBacklog, type CommandRunner, type MaintenanceContext } from "./check.ts";
import type { MacOSUpdateIO } from "./macos-updates.ts";

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
  runtimeGroup: "developer",
  skillLayers: ["developer"],
  installSteps: ["apply-dotfiles", "install-runtimes", "install-repository-dependencies"],
} as const satisfies ProfileConfig;

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
    fresh: false,
    verify: false,
  };
}

function result(stdout: string, status = 0) {
  return { status, stdout, stderr: "" };
}

test("Homebrew backlog parsing keeps exact installed and current versions", () => {
  assert.deepEqual(
    parseBrewBacklog('{"formulae":[{"name":"jq","installed_versions":["1.7"],"current_version":"1.8","pinned":true}],"casks":[{"name":"example","installed_versions":["1.0"],"current_version":"2.0","auto_updates":false}]}'),
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
    if (maxActive === 1) {
      await new Promise<void>((resolve, reject) => queueMicrotask(() => {
        if (maxActive > 1) resolve();
        else reject(new Error("maintenance probes ran sequentially"));
      }));
    }
    active -= 1;
    if (command === "df") return result("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 100 40 60 40% /\n");
    if (command === "tailscale" && args[0] === "status") return result(JSON.stringify({ BackendState: "Running", MagicDNSSuffix: "fixture.ts.net", Self: { Online: true }, Peer: {} }));
    if (command === "mise" || (command === "npm" && args[0] === "outdated")) return result("{}");
    if (command === "git") return result("");
    if (args.some((argument) => argument.endsWith("bootstrap.ts"))) return result("bootstrap verification ok\n");
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

test("macOS inventory preserves typed partial results in the maintenance probe", async () => {
  const runner: CommandRunner = async (command, args) => {
    if (command === "sw_vers" && args[0] === "-productVersion") return result("26.6.2\n");
    if (command === "sw_vers" && args[0] === "-buildVersion") return result("25G83\n");
    if (command === "defaults") return result("26.6.2\n");
    if (command === "ioreg") return result("+-o Fixture1AP <class IOPlatformExpertDevice>\n{\n\"model\" = <\"Mac99,1\">\n}\n");
    if (command === "softwareupdate") return result("Software Update Tool\nNo new software available.\n");
    if (command === "df") return result("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 100 40 60 40% /\n");
    if (command === "tailscale" && args[0] === "status") return result(JSON.stringify({ BackendState: "Running", Self: { Online: true }, Peer: {} }));
    if (command === "mise" || (command === "npm" && args[0] === "outdated")) return result("{}");
    return result("1.0.0\n");
  };
  const updateIO: MacOSUpdateIO = {
    async fetch(url) {
      if (url.includes("gdmf.apple.com")) {
        return { status: 200, body: JSON.stringify({ PublicAssetSets: { macOS: [{ ProductVersion: "26.6.2", Build: "25G83", SupportedDevices: ["Fixture1AP"] }] } }) };
      }
      if (url.includes("macos_data_feed")) {
        return { status: 200, body: JSON.stringify({ Version: "2.0", OSVersions: [{ Latest: { ProductVersion: "26.6.2", Build: "25G83" }, SupportedModels: [{ Identifiers: { "Mac99,1": "Fixture Mac" } }] }] }) };
      }
      return { status: 503, body: "unavailable" };
    },
    async readCache() { return undefined; },
    async writeCache() {},
  };
  const snapshot = await collectMaintenanceSnapshot({
    ...context(),
    platform: "darwin",
    profileConfig: { ...profileConfig, skillLayers: [] },
  }, runner, updateIO);

  assert.equal(snapshot.probes.software_update?.status, "ok");
  assert.equal(snapshot.summary.software_update_status, "current");
  assert.equal(snapshot.summary.required_failures, 0);
  const inventory = snapshot.probes.software_update?.value;
  assert.equal(inventory?.installed.os.version, "26.6.2");
  assert.equal(inventory?.installed.os.build, "25G83");
  assert.equal(inventory?.installed.device.software_update_id, "Fixture1AP");
  assert.equal(inventory?.upstream.apple_gdmf.status, "ok");
});
