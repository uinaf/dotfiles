import { Console, Effect, FileSystem, Option, Schema } from "effect";
import { dirname, join } from "node:path";
import { CommandRunner } from "../lib/command.ts";

const HttpsUrl = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isPattern(/^https:\/\/[^\s]+$/)),
);
const RuleSourceConfig = Schema.Struct({
  version: Schema.Literal(1),
  sources: Schema.NonEmptyArray(HttpsUrl),
});

export class RuleConfigurationFailure extends Schema.TaggedError<RuleConfigurationFailure>()(
  "RuleConfigurationFailure",
  { message: Schema.String },
) {}

export class RuleContentFailure extends Schema.TaggedError<RuleContentFailure>()(
  "RuleContentFailure",
  { message: Schema.String },
) {}

export class RuleRefreshUnavailable extends Schema.TaggedError<RuleRefreshUnavailable>()(
  "RuleRefreshUnavailable",
  { message: Schema.String },
) {}

export type RuleRuntime = {
  readonly fetch: (url: string) => Effect.Effect<string, RuleRefreshUnavailable>;
  readonly scan: (
    contents: string,
  ) => Effect.Effect<
    void,
    RuleContentFailure | RuleRefreshUnavailable,
    FileSystem.FileSystem | CommandRunner
  >;
};

export const parseRuleSourceConfig = Effect.fn("parseRuleSourceConfig")(function*(contents: string) {
  const parsed = yield* Effect.try({
    try: () => JSON.parse(contents) as unknown,
    catch: (error) => new RuleConfigurationFailure({
      message: `agent rule source config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    }),
  });
  return yield* Schema.decodeUnknownEffect(RuleSourceConfig, {
    errors: "all",
    onExcessProperty: "error",
  })(parsed).pipe(
    Effect.mapError((error) => new RuleConfigurationFailure({ message: error.message })),
  );
});

const normalizeRuleSource = Effect.fn("normalizeRuleSource")(function*(source: string, contents: string) {
  const normalized = contents.replaceAll(/\r\n?/g, "\n").trim();
  if (normalized.length === 0) {
    return yield* new RuleContentFailure({ message: `agent rule source is empty: ${source}` });
  }
  if (normalized === "---" || normalized.startsWith("---\n")) {
    return yield* new RuleContentFailure({ message: `agent rule source has frontmatter: ${source}` });
  }
  return normalized;
});

export const composeRuleSources = Effect.fn("composeRuleSources")(function*(
  sources: readonly { readonly contents: string; readonly source: string }[],
) {
  const fragments = yield* Effect.forEach(
    sources,
    ({ contents, source }) => normalizeRuleSource(source, contents),
  );
  const contents = `${fragments.join("\n\n")}\n`;
  if (!contents.startsWith("## General guidelines\n")) {
    return yield* new RuleContentFailure({
      message: "composed agent rules must start at ## General guidelines",
    });
  }
  return contents;
});

const fetchRuleSource = Effect.fn("fetchRuleSource")((url: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, {
        headers: { "user-agent": "dotfiles-agent-rules" },
        signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    },
    catch: (error) => new RuleRefreshUnavailable({
      message: `cannot fetch agent rule source: ${url}: ${error instanceof Error ? error.message : String(error)}`,
    }),
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.catchTag("TimeoutError", () => Effect.fail(new RuleRefreshUnavailable({
      message: `cannot fetch agent rule source: ${url}: timed out after 10 seconds`,
    }))),
  ),
);

export const scanRulesForSecrets = Effect.fn("scanRulesForSecrets")(function*(contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* CommandRunner;
  const result = yield* Effect.scoped(Effect.gen(function*() {
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "dotfiles-agent-rules." });
    yield* fs.writeFileString(join(directory, "agents.md"), contents, { mode: 0o600 });
    return yield* runner.run("gitleaks", [
      "dir",
      "--redact",
      "--exit-code",
      "183",
      "--no-banner",
      "--log-level",
      "error",
      directory,
    ]);
  })).pipe(
    Effect.mapError(() => new RuleRefreshUnavailable({ message: "agent rule secret validation is unavailable" })),
  );
  if (result.status === 183) {
    return yield* new RuleContentFailure({ message: "fetched agent rules contain a possible secret" });
  }
  if (result.status !== 0) {
    return yield* new RuleRefreshUnavailable({ message: "agent rule secret validation is unavailable" });
  }
});

export const liveRuleRuntime: RuleRuntime = {
  fetch: fetchRuleSource,
  scan: scanRulesForSecrets,
};

const readRequiredFile = Effect.fn("readRequiredAgentRuleFile")(function*(path: string, label: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(path).pipe(
    Effect.mapError(() => new RuleConfigurationFailure({ message: `cannot read ${label}: ${path}` })),
  );
});

const writeSnapshot = Effect.fn("writeAgentRuleSnapshot")(function*(path: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.scoped(Effect.gen(function*() {
    const directory = yield* fs.makeTempDirectoryScoped({
      directory: dirname(path),
      prefix: ".agent-rules.",
    });
    const temporaryPath = join(directory, "agent-rules.md");
    yield* fs.writeFileString(temporaryPath, contents, { mode: 0o644 });
    yield* fs.rename(temporaryPath, path);
  })).pipe(
    Effect.mapError(() => new RuleRefreshUnavailable({ message: "cannot update the vendored agent rule snapshot" })),
  );
});

export const refreshAgentRules = Effect.fn("refreshAgentRules")(function*(
  repoRoot: string,
  options: { readonly offline?: boolean; readonly runtime?: RuleRuntime } = {},
) {
  const configPath = join(repoRoot, "scripts/agents/rules.json");
  const snapshotPath = join(repoRoot, "chezmoi/agent-rules.md");
  const config = yield* readRequiredFile(configPath, "agent rule source config").pipe(
    Effect.flatMap(parseRuleSourceConfig),
  );
  const existing = yield* readRequiredFile(snapshotPath, "vendored agent rule snapshot");
  yield* composeRuleSources([{ source: snapshotPath, contents: existing }]);
  if (options.offline) return "offline" as const;

  const runtime = options.runtime ?? liveRuleRuntime;
  const fetched = yield* Effect.forEach(config.sources, (source) =>
    runtime.fetch(source).pipe(Effect.map((contents) => ({ source, contents }))),
  ).pipe(
    Effect.map(Option.some),
    Effect.catchTag("RuleRefreshUnavailable", (error) =>
      Console.warn(`${error.message}; using the vendored snapshot`).pipe(Effect.as(Option.none()))),
  );
  if (Option.isNone(fetched)) return "offline" as const;

  const contents = yield* composeRuleSources(fetched.value);
  const scanned = yield* runtime.scan(contents).pipe(
    Effect.as(true),
    Effect.catchTag("RuleRefreshUnavailable", (error) =>
      Console.warn(`${error.message}; using the vendored snapshot`).pipe(Effect.as(false))),
  );
  if (!scanned) return "offline" as const;
  if (contents === existing) return "current" as const;

  const written = yield* writeSnapshot(snapshotPath, contents).pipe(
    Effect.as(true),
    Effect.catchTag("RuleRefreshUnavailable", (error) =>
      Console.warn(`${error.message}; using the vendored snapshot`).pipe(Effect.as(false))),
  );
  return written ? "updated" as const : "offline" as const;
});
