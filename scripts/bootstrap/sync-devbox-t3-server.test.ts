import assert from "node:assert/strict";
import test from "node:test";

import {
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
      "--workspace",
      "/Users/example/projects/example/workspace",
      "--version",
      "t3@0.0.34-nightly.20260823.1166",
    ]),
    {
      host: "example@example-devbox",
      remoteDotfilesDirectory: "",
      version: "0.0.34-nightly.20260823.1166",
      workspaceDirectory: "/Users/example/projects/example/workspace",
    },
  );
});

test("rejects implicit hosts, relative paths, and mutable versions", () => {
  assert.throws(
    () => parseArguments(["--host", "example-devbox", "--workspace", "/tmp/workspace"]),
    /explicit user@host/,
  );
  assert.throws(
    () => parseArguments(["--host", "user@host", "--workspace", "workspace"]),
    /absolute remote path/,
  );
  assert.throws(
    () =>
      parseArguments([
        "--host",
        "user@host",
        "--workspace",
        "/tmp/workspace",
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
