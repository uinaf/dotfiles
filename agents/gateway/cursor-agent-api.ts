import { Effect, FileSystem, Option } from "effect";
import { dirname, join } from "node:path";
import { capture, credential, executable, failure, main, print, readGateway, replaceProcess } from "./gateway-runtime.ts";

main(Effect.gen(function*() {
  const home = process.env.HOME || "";
  const { config } = yield* readGateway(home);
  const fs = yield* FileSystem.FileSystem;
  let agent = config.cursorAgentBin;
  const target = yield* fs.readLink(join(home, ".local/bin/cursor-agent")).pipe(Effect.option);
  if (Option.isSome(target) && dirname(dirname(target.value)) === join(home, ".local/share/cursor-agent/versions")
    && target.value.endsWith("/cursor-agent") && executable(target.value)) agent = target.value;
  if (!agent || !executable(agent)) return yield* failure("Cursor Agent executable is unavailable");
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === "login" || command === "logout") return yield* failure("saved-login changes are disabled while the API-key client is enabled; roll back the LLM gateway first");
  if (["-v", "--version", "-h", "--help"].includes(command)) return yield* replaceProcess(agent, args);
  const env = { ...process.env, CURSOR_API_KEY: yield* credential("cursor", home), AGENT_CLI_CREDENTIAL_STORE: "memory" };
  if (command === "status" || command === "whoami" || command === "about") {
    yield* capture(agent, ["models"], env);
    if (command !== "about") return yield* print("API key authenticated");
    let format = "text";
    for (let index = 1; index < args.length; index++) {
      const arg = args[index];
      if (arg === "-h" || arg === "--help") return yield* replaceProcess(agent, args, env);
      if (arg.startsWith("--format=")) format = arg.slice(9);
      if (arg === "--format") format = args[++index] || "";
    }
    if (format !== "text" && format !== "json") return yield* replaceProcess(agent, args, env);
    const version = (yield* capture(agent, ["--version"], env)).split(/\r?\n/)[0] || "unknown";
    return yield* print(format === "json" ? JSON.stringify({ cliVersion: version, userEmail: "api-key@local" })
      : `About Cursor CLI\n\nCLI Version         ${version}\nUser Email          api-key@local\n`);
  }
  if (args.includes("acp")) return yield* replaceProcess(join(home, ".local/libexec/dotfiles/cursor-acp-api-key-auth"), [agent, ...args], env);
  yield* replaceProcess(agent, args, env);
}));
