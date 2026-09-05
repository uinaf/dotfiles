#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import type { ProfileConfig } from "../profiles/model.ts";
import { collectMaintenanceSnapshot, parseBrewBacklog, runProcess, type CommandRunner, type MaintenanceContext } from "./check.ts";
import type { MacOSUpdateIO } from "./macos-updates.ts";

const profileConfig = {
  capabilities: {
    developer: true,
    sharedHomebrew: false,
    requiresSopsIdentity: false,
    devbox: false,
    workstation: true,
    personal: false,
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

test("Homebrew backlog refreshes metadata before the greedy inventory", async () => {
  const brewCalls: string[][] = [];
  const runner: CommandRunner = async (command, args, options) => {
    if (command === "brew") {
      brewCalls.push([...args]);
      if (args[0] === "update") return result("");
      return result('{"formulae":[],"casks":[]}');
    }
    if (command === "df") return result("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 100 40 60 40% /\n");
    if (command === "tailscale" && args[0] === "status") return result(JSON.stringify({ BackendState: "Running", Self: { Online: true }, Peer: {} }));
    if (command === "mise" || (command === "npm" && args[0] === "outdated")) return result("{}");
    return result("1.0.0\n");
  };
  await collectMaintenanceSnapshot({
    ...context(),
    env: { ...context().env, HOMEBREW_NO_AUTO_UPDATE: "1" },
    ownsHomebrew: true,
    profileConfig: { ...profileConfig, skillLayers: [] },
  }, runner);
  assert.deepEqual(brewCalls, [
    ["update"],
    ["outdated", "--greedy", "--json=v2"],
  ]);
});

test("a failed Homebrew metadata refresh makes the snapshot incomplete", async () => {
  const brewCalls: string[][] = [];
  const runner: CommandRunner = async (command, args) => {
    if (command === "brew") {
      brewCalls.push([...args]);
      return result("", 1);
    }
    if (command === "df") return result("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 100 40 60 40% /\n");
    if (command === "tailscale" && args[0] === "status") return result(JSON.stringify({ BackendState: "Running", Self: { Online: true }, Peer: {} }));
    if (command === "mise" || (command === "npm" && args[0] === "outdated")) return result("{}");
    return result("1.0.0\n");
  };
  const snapshot = await collectMaintenanceSnapshot({
    ...context(),
    ownsHomebrew: true,
    profileConfig: { ...profileConfig, skillLayers: [] },
  }, runner);
  assert.deepEqual(brewCalls, [["update"]]);
  assert.equal(snapshot.probes.brew_outdated_greedy?.status, "failed");
  assert.equal(snapshot.probes.brew_outdated_greedy?.error, "brew update failed: exit 1");
  assert.equal(snapshot.summary.status, "incomplete");
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

const processOptions = { cwd: process.cwd(), env: process.env, timeoutMs: 200 };

test("finite probes kill a child that ignores TERM and preserve output", async () => {
  const started = performance.now();
  const result = await runProcess(process.execPath, ["-e", `
    process.on('SIGTERM', () => {});
    process.stdout.write('progress:' + process.pid);
    process.stderr.write('warning');
    setTimeout(() => process.exit(9), 1600);
  `], processOptions);
  const elapsed = performance.now() - started;
  assert.equal(result.timedOut, true);
  assert.match(result.stdout, /^progress:\d+$/);
  const pid = Number(result.stdout.slice("progress:".length));
  // Signal zero only checks existence; never clean fixtures up by a saved PID.
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(result.stderr, "warning");
  assert.ok(elapsed < 1000, `finite probe took ${elapsed}ms`);
  assert.equal(result.status, 1);
});

test("finite probes stop draining inherited pipes and preserve the direct child's exit", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "maintenance-pipes-"));
  const done = join(directory, "done");
  t.after(async () => {
    try {
      // The descendant self-expires; wait for its exit using only read-only PID existence checks.
      const deadline = performance.now() + 5000;
      while (true) {
        try {
          const pid = Number(await readFile(done, "utf8"));
          process.kill(pid, 0);
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error)) throw error;
          if (error.code === "ESRCH") break;
          if (error.code !== "ENOENT") throw error;
        }
        assert.ok(performance.now() < deadline, "descendant did not finish");
        await delay(20);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const descendant = `setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(done)}, String(process.pid)); process.exit(0); }, 1600)`;
  const started = performance.now();
  const result = await runProcess(process.execPath, ["-e", `
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 1, 2] }).unref();
    process.stdout.write('parent output');
    process.stderr.write('parent warning');
    process.exitCode = 7;
  `], processOptions);
  const elapsed = performance.now() - started;
  assert.equal(result.timedOut, true);
  assert.equal(result.status, 7);
  assert.equal(result.stdout, "parent output");
  assert.equal(result.stderr, "parent warning");
  assert.ok(elapsed < 1000, `inherited pipes took ${elapsed}ms`);
});

test("a TERM handler exiting successfully still reports timeout", async () => {
  const result = await runProcess(process.execPath, ["-e", `
    process.on('SIGTERM', () => { process.stdout.write('term'); process.exit(0); });
    setTimeout(() => process.exit(9), 1600);
  `], processOptions);
  assert.deepEqual(result, { status: 0, stdout: "term", stderr: "", timedOut: true });
});

test("ordinary exits and spawn failures retain their result", async () => {
  for (const status of [0, 7]) {
    const result = await runProcess(process.execPath, ["-e", `process.stdout.write('out'); process.stderr.write('err'); process.exitCode = ${status};`], { ...processOptions, timeoutMs: 2000 });
    assert.deepEqual(result, { status, stdout: "out", stderr: "err", timedOut: false });
  }
  const result = await runProcess("/nonexistent/maintenance-fixture", [], processOptions);
  assert.equal(result.status, 127);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.ok(result.error instanceof Error);
  assert.ok("code" in result.error);
  assert.equal(result.error.code, "ENOENT");
});

test("null timeout waits for completion without signalling the child", async () => {
  const result = await runProcess(process.execPath, ["-e", `
    process.on('SIGTERM', () => process.stderr.write('unexpected TERM'));
    setTimeout(() => { process.stdout.write('finished'); process.exit(7); }, 1200);
  `], { ...processOptions, timeoutMs: null });
  assert.deepEqual(result, { status: 7, stdout: "finished", stderr: "", timedOut: false });
});
