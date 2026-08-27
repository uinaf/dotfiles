#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option, Schema } from "effect";
import { dirname, join, resolve } from "node:path";
import { CommandRunner } from "../lib/command.ts";
import { CliFailure, fail, runMain } from "../lib/program.ts";

const BifrostKey = Schema.String.pipe(Schema.check(Schema.isPattern(/^sk-bf-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)));
const Auth = Schema.Record(Schema.String, Schema.Unknown);
const Config = Schema.Record(Schema.String, Schema.Unknown);
const retiredProviders = ["opencode", "opencode-go"] as const;

const program = Effect.gen(function*() {
  const args = process.argv.slice(2);
  const check = args.length === 1 && args[0] === "--check";
  if (args.length > (check ? 1 : 0)) return yield* fail("usage: configure-opencode.ts [--check]", 2);
  const home = resolve(process.env.HOME || "");
  const helper = resolve(process.env.OPENCODE_CREDENTIAL_HELPER || join(home, ".local/libexec/dotfiles/llm-gateway-credential"));
  const authPath = resolve(process.env.OPENCODE_AUTH_PATH || join(home, ".local/share/opencode/auth.json"));
  const configPath = resolve(process.env.OPENCODE_CONFIG_PATH || join(home, ".config/opencode/opencode.json"));
  const fs = yield* FileSystem.FileSystem;
  const helperLink = yield* fs.readLink(helper).pipe(Effect.option);
  const helperInfo = yield* fs.stat(helper).pipe(Effect.option);
  if (Option.isSome(helperLink) || Option.isNone(helperInfo) || helperInfo.value.type !== "File") return yield* fail(`credential helper must be a regular file: ${helper}`);
  if ((helperInfo.value.mode & 0o111) === 0) return yield* fail("credential helper must be executable");
  const runner = yield* CommandRunner;
  const credential = yield* runner.run(helper, ["bifrost"]).pipe(
    Effect.mapError(() => new CliFailure({ exitCode: 1, message: "Bifrost credential helper failed" })),
  );
  if (credential.status !== 0) return yield* fail("Bifrost credential helper failed");
  const key = yield* Schema.decodeUnknownEffect(BifrostKey)(credential.stdout.trim()).pipe(
    Effect.mapError(() => new CliFailure({ exitCode: 1, message: "credential helper returned an invalid Bifrost key" })),
  );
  let auth: Record<string, unknown> = {};
  const authLink = yield* fs.readLink(authPath).pipe(Effect.option);
  const authInfo = yield* fs.stat(authPath).pipe(Effect.option);
  if (Option.isSome(authLink)) return yield* fail(`OpenCode auth must be a regular file: ${authPath}`);
  if (Option.isSome(authInfo)) {
    if (authInfo.value.type !== "File") return yield* fail(`OpenCode auth must be a regular file: ${authPath}`);
    const source = yield* fs.readFileString(authPath);
    const parsed = yield* Effect.try({ try: () => JSON.parse(source) as unknown, catch: (error) => error });
    auth = yield* Schema.decodeUnknownEffect(Auth)(parsed).pipe(Effect.mapError(() => new CliFailure({ exitCode: 1, message: "OpenCode auth must contain a JSON object" })));
  }
  let config: Record<string, unknown> = {};
  const configLink = yield* fs.readLink(configPath).pipe(Effect.option);
  const configInfo = yield* fs.stat(configPath).pipe(Effect.option);
  if (Option.isSome(configLink)) return yield* fail(`OpenCode config must be a regular file: ${configPath}`);
  if (Option.isSome(configInfo)) {
    if (configInfo.value.type !== "File") return yield* fail(`OpenCode config must be a regular file: ${configPath}`);
    const source = yield* fs.readFileString(configPath);
    const parsed = yield* Effect.try({ try: () => JSON.parse(source) as unknown, catch: (error) => error });
    config = yield* Schema.decodeUnknownEffect(Config)(parsed).pipe(Effect.mapError(() => new CliFailure({ exitCode: 1, message: "OpenCode config must contain a JSON object" })));
  }
  const matches = (value: unknown) => typeof value === "object" && value !== null && "type" in value && "key" in value && value.type === "api" && value.key === key;
  const onlyBifrostEnabled = Array.isArray(config.enabled_providers) && config.enabled_providers.length === 1 && config.enabled_providers[0] === "bifrost";
  if (check) {
    if (Option.isNone(authInfo) || (authInfo.value.mode & 0o077) !== 0 || !matches(auth.bifrost) || retiredProviders.some((provider) => provider in auth)) return yield* fail("OpenCode Bifrost authentication drifted");
    if (Option.isNone(configInfo) || (configInfo.value.mode & 0o077) !== 0 || !onlyBifrostEnabled) return yield* fail("OpenCode provider catalog drifted");
    yield* Console.log("ok OpenCode uses the resolved Bifrost credential and only enables Bifrost");
    return;
  }
  for (const provider of retiredProviders) delete auth[provider];
  yield* Effect.scoped(Effect.gen(function*() {
    yield* fs.makeDirectory(dirname(authPath), { recursive: true, mode: 0o700 });
    const temporaryDirectory = yield* fs.makeTempDirectoryScoped({ directory: dirname(authPath), prefix: ".opencode-auth." });
    const temporary = join(temporaryDirectory, "auth.json");
    yield* fs.writeFileString(temporary, `${JSON.stringify({ ...auth, bifrost: { type: "api", key } }, null, 2)}\n`, { mode: 0o600 });
    yield* fs.rename(temporary, authPath);
    yield* fs.chmod(authPath, 0o600);
  }));
  yield* Effect.scoped(Effect.gen(function*() {
    yield* fs.makeDirectory(dirname(configPath), { recursive: true, mode: 0o700 });
    const temporaryDirectory = yield* fs.makeTempDirectoryScoped({ directory: dirname(configPath), prefix: ".opencode-config." });
    const temporary = join(temporaryDirectory, "opencode.json");
    yield* fs.writeFileString(temporary, `${JSON.stringify({ ...config, enabled_providers: ["bifrost"] }, null, 2)}\n`, { mode: 0o600 });
    yield* fs.rename(temporary, configPath);
    yield* fs.chmod(configPath, 0o600);
  }));
  yield* Console.log("configured OpenCode Bifrost authentication and provider catalog");
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

runMain(program);
