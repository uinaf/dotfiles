import { NodeServices } from "@effect/platform-node";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Fiber, FileSystem } from "effect";
import { TestClock } from "effect/testing";
import { CommandRunner } from "../lib/command.ts";
import {
  composeRuleSources,
  parseRuleSourceConfig,
  refreshAgentRules,
  RuleContentFailure,
  RuleRefreshUnavailable,
  liveRuleRuntime,
  type RuleRuntime,
} from "./rules.ts";

const originalRules = "## General guidelines\n\nOriginal rules.\n";

function createFixture(sources = ["https://rules.example.test/shared.md"]): string {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-agent-rules-"));
  mkdirSync(join(root, "scripts/agents"), { recursive: true });
  mkdirSync(join(root, "chezmoi"), { recursive: true });
  writeFileSync(join(root, "scripts/agents/rules.json"), `${JSON.stringify({ version: 1, sources })}\n`);
  writeFileSync(join(root, "chezmoi/agent-rules.md"), originalRules);
  return root;
}

function run<A>(effect: Effect.Effect<A, unknown, FileSystem.FileSystem | CommandRunner>): Promise<A> {
  return Effect.runPromise(effect.pipe(
    Effect.provide(CommandRunner.layer),
    Effect.provide(NodeServices.layer),
  ));
}

async function captureWarnings<A>(action: (warnings: string[]) => Promise<A>): Promise<A> {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) => { warnings.push(values.map(String).join(" ")); };
  try {
    return await action(warnings);
  } finally {
    console.warn = originalWarn;
  }
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

test("refreshes the snapshot only after every source and the secret scan succeed", async () => {
  const sources = ["https://rules.example.test/first.md", "https://rules.example.test/second.md"];
  const root = createFixture(sources);
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
    assert.equal(await run(refreshAgentRules(root, { runtime })), "updated");
    const expected = "## General guidelines\n\nFirst.\n\n### Delivery\n\nSecond.\n";
    assert.equal(readFileSync(join(root, "chezmoi/agent-rules.md"), "utf8"), expected);
    assert.equal(scanned, expected);
    assert.equal(await run(refreshAgentRules(root, { runtime })), "current");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("keeps the snapshot when refresh or secret validation is unavailable", async () => {
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
    const root = createFixture();
    try {
      assert.equal(await run(refreshAgentRules(root, { runtime })), "offline");
      assert.equal(readFileSync(join(root, "chezmoi/agent-rules.md"), "utf8"), originalRules);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }
});

test("includes HTTP failures in the vendored-snapshot warning", async () => {
  const root = createFixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 503 });
  try {
    await captureWarnings(async (warnings) => {
      assert.equal(await run(refreshAgentRules(root, { runtime: liveRuleRuntime })), "offline");
      assert.deepEqual(warnings, [
        "cannot fetch agent rule source: https://rules.example.test/shared.md: HTTP 503; using the vendored snapshot",
      ]);
    });
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { force: true, recursive: true });
  }
});

test("includes timeout failures in the vendored-snapshot warning", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  let timeoutError: RuleRefreshUnavailable;
  try {
    timeoutError = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(
          liveRuleRuntime.fetch("https://rules.example.test/shared.md").pipe(Effect.flip),
        );
        yield* TestClock.adjust("10 seconds");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const root = createFixture();
  const runtime: RuleRuntime = {
    fetch: () => Effect.fail(timeoutError),
    scan: () => Effect.succeed(undefined),
  };
  try {
    await captureWarnings(async (warnings) => {
      assert.equal(await run(refreshAgentRules(root, { runtime })), "offline");
      assert.deepEqual(warnings, [
        "cannot fetch agent rule source: https://rules.example.test/shared.md: timed out after 10 seconds; using the vendored snapshot",
      ]);
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("rejects invalid or secret-bearing fetched content without replacing the snapshot", async () => {
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
    const root = createFixture();
    try {
      await assert.rejects(run(refreshAgentRules(root, { runtime })), /frontmatter|possible secret/);
      assert.equal(readFileSync(join(root, "chezmoi/agent-rules.md"), "utf8"), originalRules);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }
});
