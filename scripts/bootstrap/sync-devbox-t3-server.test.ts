import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import test from "node:test";

import {
  createSyncBundle,
  parseArguments,
  parseT3NightlyVersion,
  shellQuote,
} from "./sync-devbox-t3-server.ts";

test("accepts copied nightly commands and exact versions", () => {
  const version = "0.0.34-nightly.20260823.1166";
  assert.equal(parseT3NightlyVersion(version), version);
  assert.equal(parseT3NightlyVersion(`t3@${version}`), version);
  assert.equal(parseT3NightlyVersion(`npx t3@${version}`), version);
});

test("parses an explicit portable devbox target", () => {
  assert.deepEqual(
    parseArguments([
      "--host",
      "example@example-devbox",
      "--version",
      "t3@0.0.34-nightly.20260823.1166",
    ]),
    {
      host: "example@example-devbox",
      version: "0.0.34-nightly.20260823.1166",
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
        "t3@nightly",
      ]),
    /exact T3 nightly version/,
  );
});

test("quotes remote arguments without shell interpolation", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("path with ' quote"), "'path with '\\'' quote'");
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
