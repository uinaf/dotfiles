#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option, Schema } from "effect";
import { isDeepStrictEqual } from "node:util";
import { dirname, join, resolve } from "node:path";
import { CommandRunner } from "../lib/command.ts";
import { CliFailure, fail, runMain } from "../lib/program.ts";

const BifrostKey = Schema.String.pipe(Schema.check(Schema.isPattern(/^sk-bf-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)));
const BifrostAuth = Schema.Struct({ type: Schema.Literal("api"), key: BifrostKey });
const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const GatewayConfig = Schema.Struct({ bifrostBaseUrl: Schema.String });
const retiredProviders = ["opencode", "opencode-go"] as const;
export const models = [
  { id: "ollama/kimi-k3", context: 1_048_576, output: 943_718, input: ["text", "image"] },
  { id: "ollama/deepseek-v4-flash:0731", context: 1_048_576, output: 943_718, input: ["text"] },
  { id: "ollama/glm-5.3-flash", context: 1_048_576, output: 131_072, input: ["text", "image"] },
  { id: "openrouter/qwen/qwen3.8-flash", context: 1_000_000, output: 131_072, input: ["text", "image"] },
  { id: "openrouter/z-ai/glm-5.3-flash", context: 1_048_576, output: 131_072, input: ["text", "image"] },
  { id: "openrouter/deepseek/deepseek-v4-flash-0731", context: 1_048_576, output: 943_718, input: ["text"] },
] as const;

const parseJsonObject = Effect.fn("parseJsonObject")(function*(source: string, label: string) {
  const parsed = yield* Effect.try({ try: () => JSON.parse(source) as unknown, catch: (error) => error });
  return yield* Schema.decodeUnknownEffect(JsonObject)(parsed).pipe(
    Effect.mapError(() => new CliFailure({ exitCode: 1, message: `${label} must contain a JSON object` })),
  );
});

const readObject = Effect.fn("readObject")(function*(path: string, label: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(path).pipe(Effect.option);
  if (Option.isNone(info)) return { info, value: {} as Record<string, unknown> };
  const link = yield* fs.readLink(path).pipe(Effect.option);
  if (Option.isSome(link) || info.value.type !== "File") return yield* fail(`${label} must be a regular file: ${path}`);
  return { info, value: yield* parseJsonObject(yield* fs.readFileString(path), label) };
});

const writeObject = Effect.fn("writeObject")(function*(path: string, filename: string, value: unknown) {
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.scoped(Effect.gen(function*() {
    yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryDirectory = yield* fs.makeTempDirectoryScoped({ directory: dirname(path), prefix: `.${filename}.` });
    const temporary = join(temporaryDirectory, filename);
    yield* fs.writeFileString(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    yield* fs.rename(temporary, path);
    yield* fs.chmod(path, 0o600);
  }));
});

const program = Effect.gen(function*() {
  const args = process.argv.slice(2);
  const check = args.length === 1 && args[0] === "--check";
  if (args.length > (check ? 1 : 0)) return yield* fail("usage: configure-bifrost-clients.ts [--check]", 2);
  const home = resolve(process.env.HOME || "");
  const helper = resolve(process.env.BIFROST_CREDENTIAL_HELPER || join(home, ".local/libexec/dotfiles/llm-gateway-credential"));
  const gatewayPath = resolve(process.env.LLM_GATEWAY_CONFIG || join(home, ".config/dotfiles/llm-gateway.json"));
  const authPath = resolve(process.env.OPENCODE_AUTH_PATH || join(home, ".local/share/opencode/auth.json"));
  const openCodePath = resolve(process.env.OPENCODE_CONFIG_PATH || join(home, ".config/opencode/opencode.json"));
  const piPath = resolve(process.env.PI_MODELS_PATH || join(home, ".pi/agent/models.json"));
  const fs = yield* FileSystem.FileSystem;
  const helperLink = yield* fs.readLink(helper).pipe(Effect.option);
  const helperInfo = yield* fs.stat(helper).pipe(Effect.option);
  if (Option.isSome(helperLink) || Option.isNone(helperInfo) || helperInfo.value.type !== "File") return yield* fail(`credential helper must be a regular file: ${helper}`);
  if ((helperInfo.value.mode & 0o111) === 0) return yield* fail("credential helper must be executable");
  const gateway = yield* readObject(gatewayPath, "gateway config");
  if (Option.isNone(gateway.info) || (gateway.info.value.mode & 0o077) !== 0) return yield* fail("gateway config must be owner-only");
  const decodedGateway = yield* Schema.decodeUnknownEffect(GatewayConfig)(gateway.value).pipe(
    Effect.mapError(() => new CliFailure({ exitCode: 1, message: "gateway config must contain bifrostBaseUrl" })),
  );
  const bifrostUrl = yield* Effect.try({
    try: () => new URL(decodedGateway.bifrostBaseUrl),
    catch: () => new CliFailure({ exitCode: 1, message: "bifrostBaseUrl must be an HTTPS /v1 URL" }),
  });
  if (bifrostUrl.protocol !== "https:" || bifrostUrl.username || bifrostUrl.password || bifrostUrl.search || bifrostUrl.hash || !bifrostUrl.pathname.endsWith("/v1")) {
    return yield* fail("bifrostBaseUrl must be an HTTPS /v1 URL");
  }
  const runner = yield* CommandRunner;
  const credential = yield* runner.run(helper, ["bifrost"]).pipe(
    Effect.mapError(() => new CliFailure({ exitCode: 1, message: "Bifrost credential helper failed" })),
  );
  if (credential.status !== 0) return yield* fail("Bifrost credential helper failed");
  const key = yield* Schema.decodeUnknownEffect(BifrostKey)(credential.stdout.trim()).pipe(
    Effect.mapError(() => new CliFailure({ exitCode: 1, message: "credential helper returned an invalid Bifrost key" })),
  );
  const auth = yield* readObject(authPath, "OpenCode auth");
  const openCode = yield* readObject(openCodePath, "OpenCode config");
  const pi = yield* readObject(piPath, "Pi models config");
  const openCodeProviders = openCode.value.provider === undefined
    ? {}
    : yield* Schema.decodeUnknownEffect(JsonObject)(openCode.value.provider).pipe(Effect.mapError(() => new CliFailure({ exitCode: 1, message: "OpenCode provider must contain a JSON object" })));
  const piProviders = pi.value.providers === undefined
    ? {}
    : yield* Schema.decodeUnknownEffect(JsonObject)(pi.value.providers).pipe(Effect.mapError(() => new CliFailure({ exitCode: 1, message: "Pi providers must contain a JSON object" })));
  const openCodeModels = Object.fromEntries(models.map((model) => [model.id, {
    reasoning: true,
    attachment: model.input.some((input) => input === "image"),
    limit: { context: model.context, output: model.output },
  }]));
  const desiredOpenCodeProvider = {
    npm: "@ai-sdk/openai-compatible",
    name: "bifrost",
    options: { baseURL: bifrostUrl.toString() },
    models: openCodeModels,
  };
  const desiredPiProvider = {
    baseUrl: bifrostUrl.toString(),
    api: "openai-completions",
    apiKey: `!${JSON.stringify(helper)} bifrost`,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "openai",
    },
    models: models.map((model) => ({
      id: model.id,
      reasoning: true,
      input: [...model.input],
      contextWindow: model.context,
      maxTokens: model.output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  };
  const bifrostAuth = yield* Schema.decodeUnknownEffect(BifrostAuth)(auth.value.bifrost).pipe(Effect.option);
  const onlyBifrostEnabled = Array.isArray(openCode.value.enabled_providers) && openCode.value.enabled_providers.length === 1 && openCode.value.enabled_providers[0] === "bifrost";
  if (check) {
    if (Option.isNone(auth.info) || (auth.info.value.mode & 0o077) !== 0 || Option.isNone(bifrostAuth) || bifrostAuth.value.key !== key || retiredProviders.some((provider) => provider in auth.value)) return yield* fail("OpenCode Bifrost authentication drifted");
    if (Option.isNone(openCode.info) || (openCode.info.value.mode & 0o077) !== 0 || !onlyBifrostEnabled || !isDeepStrictEqual(openCodeProviders.bifrost, desiredOpenCodeProvider)) return yield* fail("OpenCode provider catalog drifted");
    if (Option.isNone(pi.info) || (pi.info.value.mode & 0o077) !== 0 || !isDeepStrictEqual(piProviders.bifrost, desiredPiProvider)) return yield* fail("Pi provider catalog drifted");
    yield* Console.log("ok OpenCode and Pi use the six-model Bifrost catalog");
    return;
  }
  const desiredAuth = { ...auth.value };
  for (const provider of retiredProviders) delete desiredAuth[provider];
  yield* writeObject(authPath, "auth.json", { ...desiredAuth, bifrost: { type: "api", key } });
  yield* writeObject(openCodePath, "opencode.json", {
    ...openCode.value,
    provider: { ...openCodeProviders, bifrost: desiredOpenCodeProvider },
    enabled_providers: ["bifrost"],
  });
  yield* writeObject(piPath, "models.json", {
    ...pi.value,
    providers: { ...piProviders, bifrost: desiredPiProvider },
  });
  yield* Console.log("configured OpenCode and Pi with the six-model Bifrost catalog");
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

if (import.meta.main) {
  runMain(program);
}
