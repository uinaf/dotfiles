#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Clock, Console, Effect, FileSystem, Schema } from "effect";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../lib/command.ts";
import { CliFailure, fail, runMain } from "../lib/program.ts";

const Gate = Schema.Literals(["deterministic", "history"]);
const Check = Schema.Struct({
  id: Schema.NonEmptyString,
  domain: Schema.NonEmptyString,
  gate: Schema.optional(Gate),
  scope: Schema.optional(Schema.Literal("complete")),
  command: Schema.NonEmptyArray(Schema.NonEmptyString),
  inputs: Schema.NonEmptyArray(Schema.NonEmptyString),
  output: Schema.NonEmptyString,
});
const Registry = Schema.Struct({
  version: Schema.Literal(1),
  checks: Schema.NonEmptyArray(Check),
});

type Check = typeof Check.Type;
type Registry = typeof Registry.Type;

type Result = {
  readonly check: Check;
  readonly durationMs: number;
  readonly status: number;
  readonly output: string;
};

type Options = {
  readonly domains: ReadonlySet<string>;
  readonly json: boolean;
  readonly list: boolean;
  readonly skipSecurity: boolean;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const registryPath = resolve(repoRoot, "scripts/verify/checks.json");
const usageText = `Usage:
  scripts/verify/run.ts [--skip-security] [--domain NAME ...]
  scripts/verify/run.ts --list [--json]

Without --domain, runs every deterministic check in parallel. The full-history
secret scan runs afterwards unless --skip-security is set. A focused domain
omits complete-only parity checks; request --domain security explicitly for
secret scans.
`;

const parseOptions = Effect.fn("parseOptions")(function*(args: readonly string[]) {
  const domains = new Set<string>();
  let json = false;
  let list = false;
  let skipSecurity = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--domain": {
        const domain = args[index + 1];
        if (!domain) {
          yield* Console.error(usageText.trimEnd());
          return yield* fail("missing verification domain", 2);
        }
        domains.add(domain);
        index += 1;
        break;
      }
      case "--skip-security":
        skipSecurity = true;
        break;
      case "--list":
        list = true;
        break;
      case "--json":
        json = true;
        break;
      case "-h":
      case "--help":
        yield* Console.log(usageText.trimEnd());
        return undefined;
      default:
        yield* Console.error(usageText.trimEnd());
        return yield* fail(`unsupported argument ${argument}`, 2);
    }
  }

  return { domains, json, list, skipSecurity } satisfies Options;
});

const readRegistry = Effect.fn("readRegistry")(function*() {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFileString(registryPath).pipe(
    Effect.mapError((error) => new CliFailure({ exitCode: 1, message: `cannot read ${registryPath}: ${error}` })),
  );
  const json = yield* Effect.try({
    try: () => JSON.parse(contents) as unknown,
    catch: (error) => new CliFailure({ exitCode: 1, message: `${registryPath} is not valid JSON: ${String(error)}` }),
  });
  const registry = yield* Schema.decodeUnknownEffect(Registry, {
    errors: "all",
    onExcessProperty: "error",
  })(json).pipe(
    Effect.mapError((error) => new CliFailure({ exitCode: 1, message: `${registryPath} is invalid: ${error.message}` })),
  );
  const ids = registry.checks.map((check) => check.id);
  if (new Set(ids).size !== ids.length) {
    return yield* fail(`${registryPath} contains duplicate check ids`);
  }
  return registry;
});

const runCheck = Effect.fn("runCheck")(function*(check: Check): Effect.fn.Return<Result, never, CommandRunner> {
  const started = yield* Clock.currentTimeMillis;
  const runner = yield* CommandRunner;
  const [command, ...args] = check.command;
  const execution = runner.run(command, args, { cwd: repoRoot, env: { NO_COLOR: "1" } }).pipe(
    Effect.map(({ status, stderr, stdout }) => ({ output: `${stdout}${stderr}`, status })),
    Effect.catch((error) => Effect.succeed({ output: `${error.message}\n`, status: 1 })),
  );
  const result = yield* execution;
  const finished = yield* Clock.currentTimeMillis;
  return { check, durationMs: finished - started, ...result };
});

const runChecks = Effect.fn("runChecks")(function*(checks: readonly Check[]) {
  const results = yield* Effect.forEach(checks, runCheck, { concurrency: "unbounded" });
  let passed = true;

  for (const result of results) {
    const seconds = (result.durationMs / 1000).toFixed(2);
    if (result.status === 0) {
      yield* Console.log(`ok ${result.check.id} (${seconds}s)`);
      continue;
    }
    passed = false;
    yield* Effect.sync(() => {
      process.stderr.write(`\n## ${result.check.id}\n${result.output}`);
      if (!result.output.endsWith("\n")) {
        process.stderr.write("\n");
      }
      process.stderr.write(`FAILED: ${result.check.id} exited ${result.status} (${seconds}s)\n`);
    });
  }

  return passed;
});

const listRegistry = Effect.fn("listRegistry")(function*(registry: Registry, json: boolean) {
  if (json) {
    yield* Console.log(JSON.stringify(registry, null, 2));
    return;
  }
  const domains = [...new Set(registry.checks.map((check) => check.domain))].sort();
  for (const domain of domains) {
    yield* Console.log(domain);
    for (const check of registry.checks.filter((candidate) => candidate.domain === domain)) {
      yield* Console.log(`  ${check.id}${check.scope === "complete" ? " [complete only]" : ""}: ${check.output}`);
      yield* Console.log(`    inputs: ${check.inputs.join(", ")}`);
    }
  }
});

const program = Effect.gen(function*() {
  const options = yield* parseOptions(process.argv.slice(2));
  if (options === undefined) {
    return;
  }
  const registry = yield* readRegistry();
  const domains = [...new Set(registry.checks.map((check) => check.domain))].sort();
  for (const domain of options.domains) {
    if (!domains.includes(domain)) {
      return yield* fail(`unknown verification domain ${domain}; choose from ${domains.join(", ")}`, 2);
    }
  }
  if (options.list) {
    yield* listRegistry(registry, options.json);
    return;
  }

  const focused = options.domains.size > 0;
  const selected = registry.checks.filter((check) => {
    if (check.gate === "history" && options.skipSecurity) {
      return false;
    }
    if (focused) {
      return check.scope !== "complete" && options.domains.has(check.domain);
    }
    return true;
  });
  const deterministic = selected.filter((check) => check.gate !== "history");
  const history = selected.filter((check) => check.gate === "history");
  const started = yield* Clock.currentTimeMillis;

  if (!(yield* runChecks(deterministic))) {
    return yield* fail("deterministic verification failed");
  }
  if (!(yield* runChecks(history))) {
    return yield* fail("history verification failed");
  }
  const finished = yield* Clock.currentTimeMillis;
  yield* Console.log(`verification ok (${((finished - started) / 1000).toFixed(2)}s)`);
}).pipe(
  Effect.provide(CommandRunner.layer),
  Effect.provide(NodeServices.layer),
);

runMain(program);
