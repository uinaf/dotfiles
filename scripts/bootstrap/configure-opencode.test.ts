import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";

const script = resolve(import.meta.dirname, "configure-opencode.ts");

test("configures and checks OpenCode with only Bifrost enabled", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-opencode-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const helper = join(bin, "credential-helper");
  const auth = join(home, ".local/share/opencode/auth.json");
  const config = join(home, ".config/opencode/opencode.json");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, ".local/share/opencode"), { recursive: true });
  mkdirSync(join(home, ".config/opencode"), { recursive: true });
  writeFileSync(auth, `${JSON.stringify({
    anthropic: { type: "api", key: "kept" },
    opencode: { type: "api", key: "retired" },
    "opencode-go": { type: "api", key: "retired" },
  })}\n`, { mode: 0o644 });
  writeFileSync(config, `${JSON.stringify({
    plugin: ["kept"],
    provider: { bifrost: { name: "Bifrost" }, anthropic: { name: "inactive" } },
    enabled_providers: ["anthropic", "bifrost"],
  })}\n`, { mode: 0o644 });
  writeFileSync(helper, `#!/bin/sh
[ "$1" = bifrost ] || exit 2
printf 'sk-bf-11111111-1111-4111-8111-111111111111\\n'
`, { mode: 0o700 });
  chmodSync(helper, 0o700);

  const env = { ...process.env, HOME: home, OPENCODE_CREDENTIAL_HELPER: helper, OPENCODE_CONFIG_PATH: config };
  execFileSync(script, { env });
  execFileSync(script, ["--check"], { env });

  const result = JSON.parse(readFileSync(auth, "utf8"));
  assert.deepEqual(result.anthropic, { type: "api", key: "kept" });
  assert.deepEqual(result.bifrost, { type: "api", key: "sk-bf-11111111-1111-4111-8111-111111111111" });
  assert.equal("opencode" in result, false);
  assert.equal("opencode-go" in result, false);
  assert.equal(statSync(auth).mode & 0o777, 0o600);
  const configured = JSON.parse(readFileSync(config, "utf8"));
  assert.deepEqual(configured.enabled_providers, ["bifrost"]);
  assert.deepEqual(configured.plugin, ["kept"]);
  assert.deepEqual(configured.provider, { bifrost: { name: "Bifrost" }, anthropic: { name: "inactive" } });
  assert.equal(statSync(config).mode & 0o777, 0o600);
});

test("check fails when Bifrost is missing and retired slots remain", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-opencode-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const helper = join(bin, "credential-helper");
  const auth = join(home, ".local/share/opencode/auth.json");
  const config = join(home, ".config/opencode/opencode.json");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, ".local/share/opencode"), { recursive: true });
  mkdirSync(join(home, ".config/opencode"), { recursive: true });
  writeFileSync(
    auth,
    `${JSON.stringify({ opencode: { type: "api", key: "retired" } })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(config, `${JSON.stringify({ enabled_providers: ["bifrost"] })}\n`, { mode: 0o600 });
  writeFileSync(helper, `#!/bin/sh
[ "$1" = bifrost ] || exit 2
printf 'sk-bf-11111111-1111-4111-8111-111111111111\\n'
`, { mode: 0o700 });
  chmodSync(helper, 0o700);

  const env = { ...process.env, HOME: home, OPENCODE_CREDENTIAL_HELPER: helper, OPENCODE_CONFIG_PATH: config };
  assert.throws(
    () => execFileSync(script, ["--check"], { env, encoding: "utf8" }),
    (error: NodeJS.ErrnoException & { stderr?: string }) =>
      /OpenCode Bifrost authentication drifted/.test(`${error.message}\n${error.stderr ?? ""}`),
  );
});

test("check rejects additional enabled providers", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-opencode-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const helper = join(bin, "credential-helper");
  const auth = join(home, ".local/share/opencode/auth.json");
  const config = join(home, ".config/opencode/opencode.json");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, ".local/share/opencode"), { recursive: true });
  mkdirSync(join(home, ".config/opencode"), { recursive: true });
  writeFileSync(auth, `${JSON.stringify({ bifrost: { type: "api", key: "sk-bf-11111111-1111-4111-8111-111111111111" } })}\n`, { mode: 0o600 });
  writeFileSync(config, `${JSON.stringify({ enabled_providers: ["bifrost", "anthropic"] })}\n`, { mode: 0o600 });
  writeFileSync(helper, `#!/bin/sh
[ "$1" = bifrost ] || exit 2
printf 'sk-bf-11111111-1111-4111-8111-111111111111\\n'
`, { mode: 0o700 });
  chmodSync(helper, 0o700);

  const env = { ...process.env, HOME: home, OPENCODE_CREDENTIAL_HELPER: helper, OPENCODE_CONFIG_PATH: config };
  assert.throws(
    () => execFileSync(script, ["--check"], { env, encoding: "utf8" }),
    (error: NodeJS.ErrnoException & { stderr?: string }) =>
      /OpenCode provider catalog drifted/.test(`${error.message}\n${error.stderr ?? ""}`),
  );
});
