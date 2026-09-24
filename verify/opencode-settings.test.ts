import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";

const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), "../chezmoi");
const templatePath = join(sourceDir, "private_dot_config/opencode/modify_private_opencode.json");

function render(input: string) {
  return spawnSync(
    "chezmoi",
    ["--source", sourceDir, "execute-template", "--with-stdin", "--file", templatePath],
    { encoding: "utf8", input },
  );
}

test("OpenCode sharing is disabled while provider and plugin settings survive", () => {
  const existing = {
    $schema: "https://opencode.ai/config.json",
    share: "auto",
    enabled_providers: ["fixture"],
    provider: { fixture: { options: { baseURL: "https://example.invalid/v1" } } },
    plugin: ["fixture-plugin"],
  };
  const result = render(JSON.stringify(existing));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ...existing, share: "disabled" });
});

test("a missing OpenCode config is created with sharing disabled", () => {
  const result = render("");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { share: "disabled" });
});

test("malformed OpenCode config fails instead of being replaced", () => {
  const result = render('{"share":');
  assert.notEqual(result.status, 0);
});
