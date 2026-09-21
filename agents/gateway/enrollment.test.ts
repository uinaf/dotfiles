import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vite-plus/test";

import { configureGateway, grokGatewaySettings } from "./enrollment.ts";

for (const mode of ["setup", "maintenance"] as const) {
  for (const invalid of ["missing", "symlink", "permissions", "contents"] as const) {
    test(`${mode} rejects ${invalid} gateway input before changing the home`, async (t) => {
      const home = mkdtempSync(join(tmpdir(), "dotfiles-enrollment-"));
      t.onTestFinished(() => {
        vi.unstubAllEnvs();
        rmSync(home, { recursive: true, force: true });
      });
      const config = join(home, "gateway.json");
      if (invalid !== "missing") writeFileSync(config, "{}", { mode: 0o600 });
      if (invalid === "symlink") {
        rmSync(config);
        symlinkSync(join(home, "absent"), config);
      }
      if (invalid === "permissions") chmodSync(config, 0o644);
      const sentinel = join(home, "saved-login");
      writeFileSync(sentinel, "preserved", { mode: 0o600 });
      const before = readdirSync(home);
      vi.stubEnv("HOME", home);
      vi.stubEnv("CODEX_HOME", join(home, ".codex"));
      vi.stubEnv("LLM_GATEWAY_CONFIG", config);
      await assert.rejects(configureGateway(mode), /gateway config/);
      assert.deepEqual(readdirSync(home), before);
      assert.equal(readFileSync(sentinel, "utf8"), "preserved");
    });
  }
}

test("unmarked Grok gateway sections followed by another tool's comment are recognized", () => {
  const credential = "/home/user/.local/libexec/dotfiles/llm-gateway-credential";
  const unmarked = grokGatewaySettings("", "https://gatewai.example/v1", credential)
    .replace(/^# .*\n?/gm, "")
    .trimEnd();
  const contents = `[ui]\ntheme = "dark"\n\n${unmarked}\n\n# OTHER_TOOL_START\n[mcp_servers.other]\ncommand = "node"\n# OTHER_TOOL_END\n`;
  const result = grokGatewaySettings(contents, "https://gatewai.example/v1", credential);
  assert.match(result, /^\[ui\]\ntheme = "dark"\n\n+# OTHER_TOOL_START\n\[mcp_servers\.other\]/);
  assert.equal(result.match(/\[models\]/g)?.length, 1);
  assert.throws(
    () =>
      grokGatewaySettings(
        '[models]\ndefault = "other"\n',
        "https://gatewai.example/v1",
        credential,
      ),
    /conflicts with gateway section: models/,
  );
});

test("a marker-less block from the previous Grok default migrates instead of conflicting", () => {
  const credential = "/home/user/.local/libexec/dotfiles/llm-gateway-credential";
  const legacy = [
    "[models]",
    'default = "grok-4.6"',
    "",
    "[endpoints]",
    'models_base_url = "https://gatewai.example/v1"',
    "",
    "[auth]",
    `auth_provider_command = "${credential} gatewai"`,
    'auth_provider_label = "Gatewai"',
    "auth_token_ttl = 3600",
    "",
    '[model."grok-4.6"]',
    'api_backend = "responses"',
  ].join("\n");
  const result = grokGatewaySettings(
    `[ui]\ntheme = "dark"\n\n${legacy}\n`,
    "https://gatewai.example/v1",
    credential,
  );
  assert.equal(result.match(/\[models\]/g)?.length, 1);
  assert.doesNotMatch(result, /grok-4\.6/);
  assert.match(result, /default = "grok-4\.7"\ndefault_reasoning_effort = "high"/);
});
