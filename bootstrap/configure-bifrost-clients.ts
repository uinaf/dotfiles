#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { join, resolve } from "node:path";
import { configureBifrostClients } from "../agents/gateway/bifrost-clients.ts";
import { CommandRunner } from "../lib/command.ts";
import { fail, runMain } from "../lib/program.ts";

const program = Effect.gen(function* () {
  const args = process.argv.slice(2);
  const check = args.length === 1 && args[0] === "--check";
  if (args.length > (check ? 1 : 0))
    return yield* fail("usage: configure-bifrost-clients.ts [--check]", 2);
  const home = resolve(process.env.HOME || "");
  const helper = resolve(
    process.env.BIFROST_CREDENTIAL_HELPER ||
      join(home, ".local/libexec/dotfiles/llm-gateway-credential"),
  );
  const gatewayPath = resolve(
    process.env.LLM_GATEWAY_CONFIG || join(home, ".config/dotfiles/llm-gateway.json"),
  );
  const authPath = resolve(
    process.env.OPENCODE_AUTH_PATH || join(home, ".local/share/opencode/auth.json"),
  );
  const openCodePath = resolve(
    process.env.OPENCODE_CONFIG_PATH || join(home, ".config/opencode/opencode.json"),
  );
  yield* configureBifrostClients({ helper, gatewayPath, authPath, openCodePath, check });
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

if (import.meta.main) {
  runMain(program);
}
