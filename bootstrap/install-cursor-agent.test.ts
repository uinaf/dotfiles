import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

for (const status of [0, 27]) {
  test(`existing Cursor installation uses its updater and preserves exit ${status}`, t => {
    const home = mkdtempSync(join(tmpdir(), "cursor-update."));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    const log = join(home, "commands");
    writeFileSync(join(home, ".local/bin/cursor-agent"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$TEST_LOG"\nif [ "$1" = update ]; then exit ${status}; fi\nprintf 'fixture-version\\n'\n`, { mode: 0o700 });
    const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "install-cursor-agent.ts")], {
      encoding: "utf8", env: { ...process.env, HOME: home, TEST_LOG: log, CURSOR_AGENT_INSTALLER_URL: undefined },
    });
    assert.equal(result.status, status, result.stderr);
    assert.equal(readFileSync(log, "utf8"), status === 0 ? "update\n--version\n" : "update\n");
    assert.doesNotMatch(result.stdout, /downloading the official/);
  });
}
