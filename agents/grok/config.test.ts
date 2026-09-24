import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { applyManagedSettings } from "./config.ts";

function table(contents: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = contents.split(new RegExp(`^\\[${escaped}\\][ \\t]*$`, "m"));
  assert.equal(matches.length, 2, `expected exactly one [${name}] table`);
  return matches[1].split(/^\[/m)[0].split("\n");
}

function assertManaged(contents: string): void {
  assert.ok(table(contents, "ui").includes('permission_mode = "auto"'));
  assert.ok(table(contents, "cli").includes("auto_update = false"));
  assert.ok(table(contents, "features").includes("telemetry = false"));
  assert.ok(table(contents, "features").includes("feedback = false"));
  assert.ok(table(contents, "telemetry").includes("trace_upload = false"));
  assert.ok(table(contents, "harness").includes("disable_workspace_teleport = true"));
  assert.ok(table(contents, "harness").includes("disable_codebase_upload = true"));
}

const live = `[marketplace]
official_marketplace_auto_installed = true

[[marketplace.sources]]
name = "Official"
git = "https://example.invalid/marketplace.git"

[cli]
auto_update = true
installer = "npm"

[ui]
yolo = false
permission_mode = "always-approve" # set from /settings
theme = "groknight"

[plugins]
enabled = [
    "ffsstack",
    "ffss",
]

[mcp_servers.fixture]
command = "node"
args = ["/opt/fixture/[server].js", "--permission_mode=ask"]

[[hooks.Stop.hooks]]
type = "command"
command = 'node "/opt/fixture/stop.js"'

[model."grok-4.7"]
api_backend = "responses"
`;

test("managed Grok defaults replace drifted values and retired plugins in place", () => {
  const updated = applyManagedSettings(live);
  assertManaged(updated);
  assert.deepEqual(table(updated, "plugins").slice(1, 4), ["enabled = [", '    "ffss",', "]"]);
  assert.doesNotMatch(updated, /ffsstack|always-approve|auto_update = true/);
  for (const kept of [
    'installer = "npm"',
    'theme = "groknight"',
    '[[marketplace.sources]]\nname = "Official"',
    'args = ["/opt/fixture/[server].js", "--permission_mode=ask"]',
    `[[hooks.Stop.hooks]]\ntype = "command"\ncommand = 'node "/opt/fixture/stop.js"'`,
    '[model."grok-4.7"]\napi_backend = "responses"',
  ])
    assert.ok(updated.includes(kept), kept);
  assert.equal(applyManagedSettings(updated), updated);
});

test("managed Grok defaults create a configuration from nothing", () => {
  const created = applyManagedSettings("");
  assertManaged(created);
  assert.equal(applyManagedSettings(created), created);
});

test("an empty enabled list survives when only retired plugins were enabled", () => {
  const updated = applyManagedSettings('[plugins]\nenabled = ["ffsstack"]\n');
  assert.ok(table(updated, "plugins").includes("enabled = []"));
});

test("root dotted keys for a managed table are rejected rather than duplicated", () => {
  assert.throws(
    () => applyManagedSettings('ui.theme = "groknight"\n'),
    /defines ui outside a \[ui\] table/,
  );
});
