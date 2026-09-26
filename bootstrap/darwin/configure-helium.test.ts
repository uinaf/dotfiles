import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { CommandRunner } from "../../lib/command.ts";
import { configureHelium, disabledFlags, externalExtensions } from "./configure-helium.ts";

function run(root: string, status = 1, skipRunning = false) {
  return Effect.runPromise(
    configureHelium(root, skipRunning).pipe(
      Effect.provideService(
        CommandRunner,
        CommandRunner.of({
          run: () => Effect.succeed({ status, stdout: "", stderr: "" }),
        }),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );
}

function assertExternalExtensions(root: string) {
  for (const [id, url] of Object.entries(externalExtensions)) {
    const path = join(root, "External Extensions", `${id}.json`);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { external_update_url: url });
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
}

function profile(root: string, name: string, contents: string) {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "Preferences");
  writeFileSync(path, contents, { mode: 0o640 });
  return path;
}

test("all user profiles preserve unrelated preferences and converge without rewriting", async () => {
  const root = mkdtempSync(join(tmpdir(), "helium-profiles-"));
  try {
    writeFileSync(join(root, "BrowserMetrics-spare.pma"), "metrics");
    const state = join(root, "Local State");
    writeFileSync(
      state,
      '{"browser":{"enabled_labs_experiments":["helium-noise-canvas@1","other-flag@1"],"last_known_google_url":"x"},"keep":1}',
      { mode: 0o640 },
    );
    const first = profile(
      root,
      "Default",
      '{"helium":{"browser":{"layout":0,"vertical_right_aligned":true},"other":1},"keep":"dünya"}',
    );
    const second = profile(root, "Profile 2", "{}");
    const system = profile(root, "System Profile", "{}");
    const guest = profile(root, "Guest Profile", "{}");
    await run(root);
    assert.deepEqual(JSON.parse(readFileSync(first, "utf8")), {
      helium: { browser: { layout: 2, vertical_right_aligned: true }, other: 1 },
      keep: "dünya",
    });
    assert.equal(JSON.parse(readFileSync(second, "utf8")).helium.browser.layout, 2);
    assert.equal(readFileSync(system, "utf8"), "{}");
    assert.equal(readFileSync(guest, "utf8"), "{}");
    assert.equal(statSync(first).mode & 0o777, 0o640);
    assert.deepEqual(JSON.parse(readFileSync(state, "utf8")), {
      browser: {
        enabled_labs_experiments: ["other-flag@1", ...disabledFlags],
        last_known_google_url: "x",
      },
      keep: 1,
    });
    assert.equal(statSync(state).mode & 0o777, 0o640);
    assertExternalExtensions(root);
    const extension = join(
      root,
      "External Extensions",
      `${Object.keys(externalExtensions)[0]}.json`,
    );
    const modified = statSync(first).mtimeMs;
    const stateModified = statSync(state).mtimeMs;
    const extensionModified = statSync(extension).mtimeMs;
    await run(root);
    assert.equal(statSync(first).mtimeMs, modified);
    assert.equal(statSync(state).mtimeMs, stateModified);
    assert.equal(statSync(extension).mtimeMs, extensionModified);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh installation seeds a private Default profile", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "helium-new-"));
  try {
    const root = join(temporary, "Helium");
    await run(root);
    const path = join(root, "Default/Preferences");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).helium.browser.layout, 2);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const state = join(root, "Local State");
    assert.deepEqual(JSON.parse(readFileSync(state, "utf8")), {
      browser: { enabled_labs_experiments: disabledFlags },
    });
    assert.equal(statSync(state).mode & 0o777, 0o600);
    assertExternalExtensions(root);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("running browser, failed process check, and malformed profiles leave files untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "helium-invalid-"));
  try {
    const path = profile(root, "Default", "{}");
    await assert.rejects(run(root, 0), /Quit Helium/);
    await run(root, 0, true);
    await assert.rejects(run(root, 2), /Could not check/);
    for (const contents of ["not json", '{"helium":[]}', '{"helium":{"browser":42}}']) {
      const invalid = profile(root, "Profile 2", contents);
      await assert.rejects(run(root));
      assert.equal(readFileSync(invalid, "utf8"), contents);
      assert.equal(readFileSync(path, "utf8"), "{}");
    }
    rmSync(join(root, "Profile 2"), { recursive: true });
    const state = join(root, "Local State");
    for (const contents of ["not json", '{"browser":{"enabled_labs_experiments":"x"}}']) {
      writeFileSync(state, contents);
      await assert.rejects(run(root));
      assert.equal(readFileSync(state, "utf8"), contents);
      assert.equal(readFileSync(path, "utf8"), "{}");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
