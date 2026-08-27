import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import test from "node:test";

import {
  createSyncBundle,
  parseArguments,
  parseT3Version,
  remoteUpdate,
  selectWorkstationT3App,
  shellQuote,
} from "./sync-devbox-t3-server.ts";

test("accepts stable, prerelease, and copied exact versions", () => {
  assert.equal(parseT3Version("0.0.35"), "0.0.35");
  assert.equal(parseT3Version("t3@0.0.35"), "0.0.35");
  assert.equal(
    parseT3Version("npx t3@0.0.36-beta.1"),
    "0.0.36-beta.1",
  );
});

test("parses an explicit portable devbox target", () => {
  assert.deepEqual(
    parseArguments([
      "--host",
      "example@example-devbox",
      "--version",
      "t3@0.0.35",
    ]),
    {
      host: "example@example-devbox",
      version: "0.0.35",
    },
  );
});

test("rejects implicit hosts, removed path options, and mutable versions", () => {
  assert.throws(
    () => parseArguments(["--host", "example-devbox"]),
    /explicit user@host/,
  );
  assert.throws(
    () => parseArguments(["--host", "user@host", "--workspace", "/tmp/workspace"]),
    /unknown argument: --workspace/,
  );
  assert.throws(
    () => parseArguments(["--host", "user@host", "--remote-dotfiles", "/tmp/dotfiles"]),
    /unknown argument: --remote-dotfiles/,
  );
  assert.throws(
    () =>
      parseArguments([
        "--host",
        "user@host",
        "--version",
        "t3@latest",
      ]),
    /exact T3 version/,
  );
});

test("selects the installed T3 Code app without assuming a release channel", () => {
  assert.equal(selectWorkstationT3App(["T3 Code (Alpha).app"]), "T3 Code (Alpha).app");
  assert.equal(
    selectWorkstationT3App(["T3 Code (Alpha).app", "T3 Code.app"]),
    "T3 Code.app",
  );
  assert.throws(
    () => selectWorkstationT3App(["T3 Code (Alpha).app", "T3 Code (Beta).app"]),
    /multiple T3 Code apps/,
  );
});

test("quotes remote arguments without shell interpolation", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("path with ' quote"), "'path with '\\'' quote'");
});

test("installs bundled dependencies through Corepack", () => {
  assert.match(remoteUpdate, /^corepack pnpm install --frozen-lockfile --prod$/m);
  assert.doesNotMatch(remoteUpdate, /^pnpm install/m);
});

test("bundles the portable remote installer sources", () => {
  const bundle = createSyncBundle();
  const result = spawnSync("tar", ["-tf", "-"], {
    encoding: "utf8",
    input: bundle,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /^scripts\/bootstrap\/install-devbox-service-daemons\.ts$/m,
  );
  assert.match(result.stdout, /^scripts\/lib\/launchd\.ts$/m);
  assert.match(result.stdout, /^scripts\/secrets\/sops-devbox-sudo\.ts$/m);
});
