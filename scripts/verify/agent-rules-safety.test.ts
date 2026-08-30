import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import {
  cleanupFixtures,
  createFixture,
  runChezmoiResult,
  runWrapper,
  runWrapperResult,
} from "./agent-rules-fixture.ts";

afterEach(cleanupFixtures);

test("rejects local Markdown granting group or other access", () => {
  for (const [name, mode] of [
    ["agents.start.md", 0o640],
    ["agents.end.md", 0o604],
  ] as const) {
    const { home } = createFixture();
    const privateRules = join(home, ".config/dotfiles", name);
    mkdirSync(dirname(privateRules), { recursive: true });
    writeFileSync(privateRules, "### Permissive fixture rule\n");
    chmodSync(privateRules, mode);

    const result = runWrapperResult(home);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /local agent rules must not grant group or other access/);
  }
});

test("rejects a broken local Markdown link", () => {
  for (const [name, profile] of [
    ["agents.start.md", "workstation"],
    ["agents.end.md", "personal-devbox"],
  ] as const) {
    const { home } = createFixture();
    const privateRules = join(home, ".config/dotfiles", name);
    mkdirSync(dirname(privateRules), { recursive: true });
    symlinkSync(join(home, `missing-${name}`), privateRules);

    const result = runWrapperResult(home, profile);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /local agent rules link is broken/);
  }
});

test("rejects local Markdown owned by another user", (context) => {
  if (process.getuid?.() === 0) {
    context.skip("requires a non-root test runner");
    return;
  }
  const { home } = createFixture();
  const privateRules = join(home, ".config/dotfiles/agents.end.md");
  mkdirSync(dirname(privateRules), { recursive: true });
  symlinkSync("/usr/bin/true", privateRules);

  const result = runWrapperResult(home);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /local agent rules must be owned by the current user/);
});

test("rejects a local Markdown symlink resolving to a directory", () => {
  for (const name of ["agents.start.md", "agents.end.md"]) {
    const { config, home, root } = createFixture();
    const privateRules = join(home, ".config/dotfiles", name);
    const directory = join(root, "private/rules");
    mkdirSync(dirname(privateRules), { recursive: true });
    mkdirSync(directory, { recursive: true });
    symlinkSync(directory, privateRules);

    const wrapperResult = runWrapperResult(home);
    const chezmoiResult = runChezmoiResult(home, config, "apply");

    assert.notEqual(wrapperResult.status, 0);
    assert.match(wrapperResult.stderr, /local agent rules must resolve to a regular file/);
    assert.notEqual(chezmoiResult.status, 0);
    assert.match(chezmoiResult.stderr, new RegExp(`${name.replaceAll(".", "\\.")} must resolve to a regular file`));
  }
});

test("ignores broken local Markdown links for workload profiles", () => {
  for (const name of ["agents.start.md", "agents.end.md"]) {
    const { home } = createFixture();
    const privateRules = join(home, ".config/dotfiles", name);
    mkdirSync(dirname(privateRules), { recursive: true });
    symlinkSync(join(home, `missing-${name}`), privateRules);

    runWrapper(home, "assistant");

    assert.equal(readdirSync(home).includes("AGENTS.md"), false);
  }
});
