#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem } from "effect";
import { join, resolve } from "node:path";
import { CommandRunner } from "../lib/command.ts";
import { fail, runMain } from "../lib/program.ts";

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* CommandRunner;
  const home = process.env.HOME || "";
  const installerUrl = process.env.CURSOR_AGENT_INSTALLER_URL || "https://cursor.com/install";
  const installerPath = yield* fs.makeTempFileScoped({ prefix: "cursor-agent-install." });
  const agentPath = join(home, ".local/bin/cursor-agent");
  const devboxConfig = process.env.DEVBOX_CONFIG || join(home, ".config/dotfiles/devbox.env");

  yield* Console.log("downloading the official Cursor Agent installer");
  const download = yield* runner.run("curl", ["-fsSL", installerUrl, "-o", installerPath], { output: "inherit" });
  if (download.status !== 0) return yield* fail(`Cursor Agent download exited ${download.status}`);
  yield* Console.log(`installing Cursor Agent for ${process.env.USER || "current user"}`);
  const install = yield* runner.run("bash", [installerPath], { output: "inherit" });
  if (install.status !== 0) return yield* fail(`Cursor Agent installer exited ${install.status}`);

  const gatewayState = join(home, ".config/dotfiles/llm-gateway-state.json");
  const legacyGatewayState = join(home, ".config/dotfiles/llm-client-state.json");
  if ((yield* fs.exists(gatewayState)) || (yield* fs.exists(legacyGatewayState))) {
    yield* Console.log("reapplying canonical Cursor API-key commands");
    const configure = yield* runner.run(process.execPath, [
      resolve(import.meta.dirname, "configure-llm-gateway.ts"),
    ], { output: "inherit" });
    if (configure.status !== 0) return yield* fail(`LLM gateway configuration exited ${configure.status}`);
  }

  const configReadable = yield* fs.access(devboxConfig, { readable: true }).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );
  const version = yield* runner.run(agentPath, ["--version"], {
    env: configReadable ? { AGENT_CLI_CREDENTIAL_STORE: "file" } : {},
    output: "inherit",
  }).pipe(Effect.catch(() => fail(`Cursor Agent was not installed at ${agentPath}`)));
  if (version.status !== 0) return yield* fail(`Cursor Agent version check exited ${version.status}`);
}).pipe(
  Effect.scoped,
  Effect.provide(CommandRunner.layer),
  Effect.provide(NodeServices.layer),
);

runMain(program);
