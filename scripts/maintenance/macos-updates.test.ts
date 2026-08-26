#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import {
  collectMacOSUpdateInventory,
  compareBuilds,
  compareVersions,
  parseSoftwareUpdate,
  selectGdmfBaseline,
  selectSofaMacOSBaseline,
  type CommandRunner,
  type HttpResult,
  type MacOSUpdateIO,
} from "./macos-updates.ts";

const now = "2026-08-26T12:00:00.000Z";
const deviceOutput = `+-o Fixture1AP <class IOPlatformExpertDevice>
{
  "compatible" = <"Fixture1AP","Mac99,1","AppleARM">
  "model" = <"Mac99,1">
}`;

const gdmf = {
  PublicAssetSets: {
    macOS: [
      { ProductVersion: "26.6.1", Build: "25G76", SupportedDevices: ["OlderAP"] },
      { ProductVersion: "26.6.2", Build: "25G83", SupportedDevices: ["Fixture1AP", "Mac99,1"] },
    ],
  },
};

const sofaMacOS = {
  Version: "2.0",
  OSVersions: [
    {
      Latest: { ProductVersion: "26.6.2", Build: "25G83" },
      SupportedModels: [{ Identifiers: { "Mac99,1": "Fixture Mac" } }],
    },
    {
      Latest: { ProductVersion: "15.7.9", Build: "24G830" },
      SupportedModels: [{ Identifiers: { "Mac98,1": "Older Fixture Mac" } }],
    },
  ],
};

const sofaSafari = {
  Version: "2.0",
  AppVersions: [
    { AppVersion: "Safari 26", Latest: { ProductVersion: "26.6.1" } },
    { AppVersion: "Safari 18", Latest: { ProductVersion: "18.6" } },
  ],
};

function commandResult(stdout: string, status = 0) {
  return { status, stdout, stderr: "" };
}

function runner(options: {
  cached?: string;
  live?: string;
  liveStatus?: number;
  osVersion?: string;
  osBuild?: string;
  safariVersion?: string;
  calls?: Array<{ command: string; args: readonly string[]; timeoutMs: number | null }>;
} = {}): CommandRunner {
  return async (command, args, runOptions) => {
    options.calls?.push({ command, args, timeoutMs: runOptions.timeoutMs });
    if (command === "sw_vers" && args[0] === "-productVersion") return commandResult(`${options.osVersion ?? "26.6.2"}\n`);
    if (command === "sw_vers" && args[0] === "-buildVersion") return commandResult(`${options.osBuild ?? "25G83"}\n`);
    if (command === "defaults") return commandResult(`${options.safariVersion ?? "26.6.2"}\n`);
    if (command === "ioreg") return commandResult(deviceOutput);
    if (command === "softwareupdate" && args.includes("--no-scan")) {
      return commandResult(options.cached ?? "Software Update Tool\nNo new software available.\n");
    }
    if (command === "softwareupdate") return commandResult(options.live ?? "Software Update Tool\nNo new software available.\n", options.liveStatus);
    throw new Error(`unexpected command ${command} ${args.join(" ")}`);
  };
}

function io(options: {
  apple?: HttpResult;
  macos?: HttpResult;
  safari?: HttpResult;
  cache?: string;
  fetches?: string[];
  writes?: string[];
} = {}): MacOSUpdateIO {
  return {
    async fetch(url) {
      options.fetches?.push(url);
      if (url.includes("gdmf.apple.com")) return options.apple ?? { status: 200, body: JSON.stringify(gdmf) };
      if (url.includes("macos_data_feed")) return options.macos ?? { status: 200, body: JSON.stringify(sofaMacOS) };
      return options.safari ?? { status: 200, body: JSON.stringify(sofaSafari) };
    },
    async readCache() {
      return options.cache;
    },
    async writeCache(_path, contents) {
      options.writes?.push(contents);
    },
  };
}

function collect(run: CommandRunner, updateIO: MacOSUpdateIO) {
  return collectMacOSUpdateInventory({
    cachePath: "/fixture/cache/apple-gdmf.json",
    cwd: "/fixture/repo",
    env: { HOME: "/fixture/home" },
    fresh: false,
    home: "/fixture/home",
    now,
  }, run, updateIO);
}

test("version and Apple build comparison use numeric release order", () => {
  assert.equal(compareVersions("26.10", "26.9.9"), 1);
  assert.equal(compareVersions("26.6", "26.6.0"), 0);
  assert.equal(compareVersions("15.7.9", "26.0"), -1);
  assert.equal(compareBuilds("25G83", "25G76"), 1);
  assert.equal(compareBuilds("25G83", "24G830"), 1);
  assert.equal(compareBuilds("25F100", "25G1"), -1);
  assert.equal(compareBuilds("25G83", "25G83a"), 1);
});

test("GDMF uses the software-update device identifier and selects its newest release", () => {
  assert.deepEqual(selectGdmfBaseline(gdmf, ["Fixture1AP", "Mac99,1"]), {
    version: "26.6.2",
    build: "25G83",
    source: "apple_gdmf",
    device_match: "Fixture1AP",
  });
});

test("SOFA matches the model without depending on the executing Mac", () => {
  assert.deepEqual(selectSofaMacOSBaseline(sofaMacOS, "Mac99,1"), {
    version: "26.6.2",
    build: "25G83",
    source: "sofa_macos",
    device_match: "Mac99,1",
  });
});

test("upstream parsers reject missing, malformed, and incompatible feeds", () => {
  assert.throws(() => selectGdmfBaseline({}, ["Fixture1AP"]));
  assert.throws(() => selectGdmfBaseline({ PublicAssetSets: { macOS: [{ ProductVersion: "latest" }] } }, ["Fixture1AP"]));
  assert.throws(() => selectGdmfBaseline(gdmf, ["UnknownAP"]), /incompatible/);
  assert.throws(() => selectSofaMacOSBaseline(sofaMacOS, "Mac0,0"), /incompatible/);
});

test("softwareupdate parsing distinguishes cached emptiness from a malformed listing", () => {
  assert.deepEqual(parseSoftwareUpdate(commandResult("Software Update Tool\nNo new software available.\n")), {
    available: false,
    restart_required: false,
    items: [],
  });
  assert.throws(() => parseSoftwareUpdate(commandResult("Software Update Tool\nFinding available software\n")), /unsupported listing/);
});

test("routine inventory preserves source and freshness without a live scan", async () => {
  const calls: Array<{ command: string; args: readonly string[]; timeoutMs: number | null }> = [];
  const inventory = await collect(runner({ calls }), io());

  assert.equal(inventory.applicability.status, "current");
  assert.equal(inventory.applicability.basis, "cached_and_upstream");
  assert.equal(inventory.cached_applicability.freshness, "cached_previous_scan");
  assert.equal(inventory.upstream.apple_gdmf.status, "ok");
  assert.equal(inventory.upstream.apple_gdmf.freshness, "live");
  assert.equal(inventory.upstream.sofa_macos.baseline?.version, "26.6.2");
  assert.equal(inventory.upstream.sofa_safari.baseline?.version, "26.6.1");
  assert.equal(inventory.live_scan.status, "not_run");
  assert.equal(calls.filter((call) => call.command === "softwareupdate" && !call.args.includes("--no-scan")).length, 0);
});

test("a fresh daily Apple cache avoids another Apple request", async () => {
  const fetches: string[] = [];
  const cache = JSON.stringify({ schema_version: 1, checked_at: now, fetched_at: now, payload: gdmf });
  const inventory = await collect(runner(), io({ cache, fetches }));

  assert.equal(inventory.upstream.apple_gdmf.status, "ok");
  assert.equal(inventory.upstream.apple_gdmf.freshness, "daily_cache");
  assert.equal(fetches.filter((url) => url.includes("gdmf.apple.com")).length, 0);
  assert.equal(fetches.length, 2);
});

test("a stale Apple cache stays visible when SOFA can establish current state", async () => {
  const cache = JSON.stringify({
    schema_version: 1,
    checked_at: "2026-08-24T12:00:00.000Z",
    fetched_at: "2026-08-24T12:00:00.000Z",
    payload: gdmf,
  });
  const inventory = await collect(runner(), io({
    cache,
    apple: { status: 503, body: "unavailable" },
  }));

  assert.equal(inventory.upstream.apple_gdmf.status, "stale");
  assert.equal(inventory.upstream.apple_gdmf.freshness, "stale_cache");
  assert.equal(inventory.upstream.apple_gdmf.failure_kind, "transient");
  assert.equal(inventory.upstream.sofa_macos.status, "ok");
  assert.equal(inventory.live_scan.status, "not_run");
  assert.equal(inventory.applicability.status, "current");
});

test("malformed cached applicability triggers the live path without a timeout", async () => {
  const calls: Array<{ command: string; args: readonly string[]; timeoutMs: number | null }> = [];
  const inventory = await collect(runner({ cached: "Software Update Tool\nFinding available software\n", calls }), io());
  const live = calls.find((call) => call.command === "softwareupdate" && !call.args.includes("--no-scan"));

  assert.equal(inventory.cached_applicability.status, "failed");
  assert.ok(inventory.live_scan.reasons.includes("cached_applicability_invalid"));
  assert.equal(inventory.live_scan.status, "current");
  assert.equal(live?.timeoutMs, null);
});

test("a cached backlog triggers a live applicability scan", async () => {
  const inventory = await collect(runner({
    cached: "Software Update Tool\n* Label: Safari26.6.1\nTitle: Safari, Version: 26.6.1, Recommended: YES\n",
  }), io());

  assert.ok(inventory.live_scan.reasons.includes("cached_backlog_nonempty"));
  assert.equal(inventory.live_scan.freshness, "live");
});

test("a newer upstream build triggers a live applicability scan", async () => {
  const inventory = await collect(runner({ osBuild: "25G76" }), io());

  assert.ok(inventory.live_scan.reasons.includes("upstream_os_newer"));
  assert.equal(inventory.live_scan.status, "current");
});

test("unavailable upstream sources fail closed through the live path", async () => {
  const unavailable = { status: 503, body: "unavailable" };
  const inventory = await collect(runner(), io({ apple: unavailable, macos: unavailable, safari: unavailable }));

  assert.equal(inventory.upstream.apple_gdmf.status, "unavailable");
  assert.equal(inventory.upstream.sofa_macos.status, "unavailable");
  assert.equal(inventory.upstream.sofa_safari.status, "unavailable");
  assert.ok(inventory.live_scan.reasons.includes("upstream_os_unavailable"));
  assert.ok(inventory.live_scan.reasons.includes("upstream_safari_unavailable"));
  assert.equal(inventory.applicability.basis, "live");
});

test("device-incompatible upstream data is labeled and fails closed", async () => {
  const incompatibleGdmf = { PublicAssetSets: { macOS: [{ ProductVersion: "26.6.2", Build: "25G83", SupportedDevices: ["OtherAP"] }] } };
  const incompatibleSofa = { Version: "2.0", OSVersions: [{ Latest: { ProductVersion: "26.6.2", Build: "25G83" }, SupportedModels: [{ Identifiers: { "Mac0,0": "Other Mac" } }] }] };
  const inventory = await collect(runner(), io({
    apple: { status: 200, body: JSON.stringify(incompatibleGdmf) },
    macos: { status: 200, body: JSON.stringify(incompatibleSofa) },
  }));

  assert.equal(inventory.upstream.apple_gdmf.status, "incompatible");
  assert.equal(inventory.upstream.sofa_macos.status, "incompatible");
  assert.ok(inventory.live_scan.reasons.includes("upstream_os_unavailable"));
});

test("an advisory Safari failure is visible and requests live applicability", async () => {
  const inventory = await collect(runner(), io({ safari: { status: 200, body: "{" } }));

  assert.equal(inventory.upstream.sofa_safari.status, "malformed");
  assert.equal(inventory.upstream.sofa_safari.failure_kind, "validation");
  assert.ok(inventory.live_scan.reasons.includes("upstream_safari_unavailable"));
});

test("explicit fresh inventory always runs and labels the live path", async () => {
  const inventory = await collectMacOSUpdateInventory({
    cachePath: "/fixture/cache/apple-gdmf.json",
    cwd: "/fixture/repo",
    env: { HOME: "/fixture/home" },
    fresh: true,
    home: "/fixture/home",
    now,
  }, runner(), io());

  assert.deepEqual(inventory.live_scan.reasons, ["explicit_fresh"]);
  assert.equal(inventory.live_scan.freshness, "live");
});

test("a failed live scan keeps installed and upstream partial results", async () => {
  const inventory = await collectMacOSUpdateInventory({
    cachePath: "/fixture/cache/apple-gdmf.json",
    cwd: "/fixture/repo",
    env: { HOME: "/fixture/home" },
    fresh: true,
    home: "/fixture/home",
    now,
  }, runner({ live: "scan failed", liveStatus: 1 }), io());

  assert.equal(inventory.live_scan.status, "failed");
  assert.equal(inventory.applicability.status, "unknown");
  assert.equal(inventory.installed.os.version, "26.6.2");
  assert.equal(inventory.upstream.selected_os?.build, "25G83");
});
