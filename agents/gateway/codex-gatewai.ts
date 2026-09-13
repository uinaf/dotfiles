import { Effect } from "effect";
import { dirname, resolve, join } from "node:path";
import { codexGatewaiOverrides } from "./gateway-config.ts";
import { main, print, readGateway, replaceProcess } from "./gateway-runtime.ts";

main(Effect.gen(function*() {
  const directory = dirname(resolve(process.argv[1]));
  const home = resolve(directory, "../../..");
  const { path, config } = yield* readGateway(home);
  const overrides = codexGatewaiOverrides(config, join(directory, "llm-gateway-credential"));
  if (process.argv[2] === "--gateway-overrides") return yield* print(overrides.join("\n"));
  yield* replaceProcess("codex", [...overrides.flatMap((value) => ["-c", value]), ...process.argv.slice(2)], {
    ...process.env, LLM_GATEWAY_CONFIG: path,
  });
}));
