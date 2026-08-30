import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";

import { models } from "./configure-bifrost-clients.ts";

const script = resolve(import.meta.dirname, "configure-bifrost-clients.ts");
const modelIds = models.map((model) => model.id);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-bifrost-clients-"));
  const home = join(root, "home");
  const helper = join(root, "bin", "credential-helper");
  const gateway = join(home, ".config/dotfiles/llm-gateway.json");
  const auth = join(home, ".local/share/opencode/auth.json");
  const openCode = join(home, ".config/opencode/opencode.json");
  const pi = join(home, ".pi/agent/models.json");
  for (const directory of [join(root, "bin"), join(home, ".config/dotfiles"), dirname(auth), dirname(openCode), dirname(pi)]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(gateway, `${JSON.stringify({ bifrostBaseUrl: "https://bifrost.example/v1" })}\n`, { mode: 0o600 });
  writeFileSync(auth, `${JSON.stringify({
    anthropic: { type: "api", key: "kept" },
    opencode: { type: "api", key: "retired" },
    "opencode-go": { type: "api", key: "retired" },
  })}\n`, { mode: 0o644 });
  writeFileSync(openCode, `${JSON.stringify({
    plugin: ["kept"],
    provider: { bifrost: { name: "stale" }, anthropic: { name: "inactive" } },
    enabled_providers: ["anthropic", "bifrost"],
  })}\n`, { mode: 0o644 });
  writeFileSync(pi, `${JSON.stringify({
    providers: { bifrost: { models: [{ id: "retired" }] }, local: { baseUrl: "http://localhost" } },
  })}\n`, { mode: 0o644 });
  writeFileSync(helper, `#!/bin/sh
[ "$1" = bifrost ] || exit 2
printf 'sk-bf-11111111-1111-4111-8111-111111111111\\n'
`, { mode: 0o700 });
  chmodSync(helper, 0o700);
  return {
    auth,
    openCode,
    pi,
    env: {
      ...process.env,
      HOME: home,
      BIFROST_CREDENTIAL_HELPER: helper,
      LLM_GATEWAY_CONFIG: gateway,
      OPENCODE_AUTH_PATH: auth,
      OPENCODE_CONFIG_PATH: openCode,
      PI_MODELS_PATH: pi,
    },
  };
}

test("configures and checks OpenCode and Pi with the Bifrost catalog", () => {
  const paths = fixture();
  execFileSync(script, { env: paths.env });
  execFileSync(script, ["--check"], { env: paths.env });

  const auth = JSON.parse(readFileSync(paths.auth, "utf8"));
  assert.deepEqual(auth.anthropic, { type: "api", key: "kept" });
  assert.deepEqual(auth.bifrost, { type: "api", key: "sk-bf-11111111-1111-4111-8111-111111111111" });
  assert.equal("opencode" in auth, false);
  assert.equal("opencode-go" in auth, false);

  const openCode = JSON.parse(readFileSync(paths.openCode, "utf8"));
  assert.deepEqual(openCode.enabled_providers, ["bifrost"]);
  assert.deepEqual(openCode.plugin, ["kept"]);
  assert.deepEqual(Object.keys(openCode.provider.bifrost.models), modelIds);
  assert.equal(openCode.provider.bifrost.name, "bifrost");
  assert.equal(openCode.provider.bifrost.models[models[0].id].limit.context, models[0].context);
  assert.deepEqual(openCode.provider.anthropic, { name: "inactive" });

  const pi = JSON.parse(readFileSync(paths.pi, "utf8"));
  assert.deepEqual(pi.providers.bifrost.models.map((model: { id: string }) => model.id), modelIds);
  assert.equal(pi.providers.bifrost.baseUrl, "https://bifrost.example/v1");
  assert.match(pi.providers.bifrost.apiKey, /^!".*credential-helper" bifrost$/);
  assert.equal(pi.providers.bifrost.models[0].contextWindow, models[0].context);
  assert.deepEqual(pi.providers.local, { baseUrl: "http://localhost" });

  for (const path of [paths.auth, paths.openCode, paths.pi]) assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("check rejects authentication and catalog drift", () => {
  const paths = fixture();
  execFileSync(script, { env: paths.env });
  const pi = JSON.parse(readFileSync(paths.pi, "utf8"));
  pi.providers.bifrost.models = [];
  writeFileSync(paths.pi, `${JSON.stringify(pi)}\n`, { mode: 0o600 });
  assert.throws(
    () => execFileSync(script, ["--check"], { env: paths.env, encoding: "utf8" }),
    (error: NodeJS.ErrnoException & { stderr?: string }) => /Pi provider catalog drifted/.test(`${error.message}\n${error.stderr ?? ""}`),
  );

  execFileSync(script, { env: paths.env });
  writeFileSync(paths.auth, `${JSON.stringify({ opencode: { type: "api", key: "retired" } })}\n`, { mode: 0o600 });
  assert.throws(
    () => execFileSync(script, ["--check"], { env: paths.env, encoding: "utf8" }),
    (error: NodeJS.ErrnoException & { stderr?: string }) => /OpenCode Bifrost authentication drifted/.test(`${error.message}\n${error.stderr ?? ""}`),
  );
});
