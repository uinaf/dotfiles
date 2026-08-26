import { NodeServices } from "@effect/platform-node";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, FileSystem } from "effect";
import { CommandRunner } from "../lib/command.ts";
import {
  composeRuleSources,
  parseRuleSourceConfig,
  refreshAgentRules,
  RuleContentFailure,
  RuleRefreshUnavailable,
  type RuleRuntime,
} from "./rules.ts";

const originalRules = "## General guidelines\n\nOriginal rules.\n";

function createFixture(
  sources = ["https://rules.example.test/shared.md"],
  options: { readonly cached?: boolean } = { cached: true },
): { cache: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-agent-rules-"));
  const cache = join(root, "state/dotfiles/agent-rules.md");
  mkdirSync(join(root, "scripts/agents"), { recursive: true });
  writeFileSync(join(root, "scripts/agents/rules.json"), `${JSON.stringify({ version: 1, sources })}\n`);
  if (options.cached !== false) {
    mkdirSync(join(root, "state/dotfiles"), { recursive: true });
    writeFileSync(cache, originalRules);
  }
  return { cache, root };
}

function run<A>(effect: Effect.Effect<A, unknown, FileSystem.FileSystem | CommandRunner>): Promise<A> {
  return Effect.runPromise(effect.pipe(
    Effect.provide(CommandRunner.layer),
    Effect.provide(NodeServices.layer),
  ));
}

test("parses a strict ordered HTTPS source config", async () => {
  const parsed = await Effect.runPromise(parseRuleSourceConfig(JSON.stringify({
    version: 1,
    sources: ["https://rules.example.test/first.md", "https://rules.example.test/second.md"],
  })));
  assert.deepEqual(parsed.sources, [
    "https://rules.example.test/first.md",
    "https://rules.example.test/second.md",
  ]);
  await assert.rejects(
    Effect.runPromise(parseRuleSourceConfig('{"version":1,"sources":[],"extra":true}')),
    /sources|extra/,
  );
  await assert.rejects(
    Effect.runPromise(parseRuleSourceConfig('{"version":1,"sources":["http:\/\/rules.example.test"]}')),
    /sources/,
  );
});

test("composes normalized source fragments in configured order", async () => {
  const contents = await Effect.runPromise(composeRuleSources([
    { source: "first", contents: "\r\n## General guidelines\r\n\r\nFirst.\r\n" },
    { source: "second", contents: "\n### Delivery\n\nSecond.\n\n" },
  ]));
  assert.equal(contents, "## General guidelines\n\nFirst.\n\n### Delivery\n\nSecond.\n");
  await assert.rejects(
    Effect.runPromise(composeRuleSources([{ source: "empty", contents: " \n" }])),
    /source is empty/,
  );
  await assert.rejects(
    Effect.runPromise(composeRuleSources([{ source: "frontmatter", contents: "---\ntitle: rules\n---\n" }])),
    /has frontmatter/,
  );
  await assert.rejects(
    Effect.runPromise(composeRuleSources([{ source: "heading", contents: "# Agent rules\n" }])),
    /must start at ## General guidelines/,
  );
});

test("refreshes the cache only after every source and the secret scan succeed", async () => {
  const sources = ["https://rules.example.test/first.md", "https://rules.example.test/second.md"];
  const { cache, root } = createFixture(sources, { cached: false });
  const fetched = new Map([
    [sources[0], "## General guidelines\n\nFirst.\n"],
    [sources[1], "### Delivery\n\nSecond.\n"],
  ]);
  let scanned = "";
  const runtime: RuleRuntime = {
    fetch: (url) => Effect.succeed(fetched.get(url) ?? ""),
    scan: (contents) => Effect.sync(() => { scanned = contents; }),
  };
  try {
    assert.equal(await run(refreshAgentRules(root, cache, { runtime })), "updated");
    const expected = "## General guidelines\n\nFirst.\n\n### Delivery\n\nSecond.\n";
    assert.equal(readFileSync(cache, "utf8"), expected);
    assert.equal(statSync(cache).mode & 0o777, 0o600);
    assert.equal(scanned, expected);
    assert.equal(await run(refreshAgentRules(root, cache, { runtime })), "current");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("keeps the cache when refresh or secret validation is unavailable", async () => {
  const runtimes: RuleRuntime[] = [
    {
      fetch: (url) => Effect.fail(new RuleRefreshUnavailable({ message: `offline: ${url}` })),
      scan: () => Effect.succeed(undefined),
    },
    {
      fetch: () => Effect.succeed("## General guidelines\n\nFetched.\n"),
      scan: () => Effect.fail(new RuleRefreshUnavailable({ message: "scanner unavailable" })),
    },
  ];
  for (const runtime of runtimes) {
    const { cache, root } = createFixture();
    try {
      assert.equal(await run(refreshAgentRules(root, cache, { runtime })), "offline");
      assert.equal(readFileSync(cache, "utf8"), originalRules);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }
});

test("rejects invalid or secret-bearing fetched content without replacing the cache", async () => {
  const runtimes: RuleRuntime[] = [
    {
      fetch: () => Effect.succeed("---\ntitle: rules\n---\n"),
      scan: () => Effect.succeed(undefined),
    },
    {
      fetch: () => Effect.succeed("## General guidelines\n\nFetched.\n"),
      scan: () => Effect.fail(new RuleContentFailure({ message: "possible secret" })),
    },
  ];
  for (const runtime of runtimes) {
    const { cache, root } = createFixture();
    try {
      await assert.rejects(run(refreshAgentRules(root, cache, { runtime })), /frontmatter|possible secret/);
      assert.equal(readFileSync(cache, "utf8"), originalRules);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }
});

test("requires a machine-local cache when offline or refresh is unavailable", async () => {
  const { cache, root } = createFixture(undefined, { cached: false });
  const runtime: RuleRuntime = {
    fetch: (url) => Effect.fail(new RuleRefreshUnavailable({ message: `offline: ${url}` })),
    scan: () => Effect.succeed(undefined),
  };
  try {
    await assert.rejects(run(refreshAgentRules(root, cache, { offline: true })), /cache is unavailable/);
    await assert.rejects(run(refreshAgentRules(root, cache, { runtime })), /offline.*cache is unavailable/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
