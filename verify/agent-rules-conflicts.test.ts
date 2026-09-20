import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "vite-plus/test";

import {
  assertManagedRules,
  cleanupFixtures,
  createFixture,
  runWrapper,
} from "./agent-rules-fixture.ts";

afterEach(cleanupFixtures);

test("omits the private start layer for blank Markdown", () => {
  const { home } = createFixture();
  const privateStart = join(home, ".config/dotfiles/agents.start.md");
  mkdirSync(dirname(privateStart), { recursive: true });
  writeFileSync(privateStart, " \n\t\n");
  chmodSync(privateStart, 0o600);

  runWrapper(home);

  assert.match(assertManagedRules(home), /^## General guidelines/);
});

test("replaces a conflicting rule file without a backup", () => {
  const { home } = createFixture();
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/CLAUDE.md"), "unmanaged fixture rules\n");

  runWrapper(home);

  assertManagedRules(home);
  assert.equal(
    readdirSync(join(home, ".claude")).some((name) => name.includes(".backup.")),
    false,
  );
});

test("replaces a conflicting home rule file without a backup", () => {
  const { home } = createFixture();
  writeFileSync(join(home, "AGENTS.md"), "unmanaged fixture rules\n");

  runWrapper(home);

  assertManagedRules(home);
  assert.equal(
    readdirSync(home).some((name) => name.startsWith("AGENTS.md.backup.")),
    false,
  );
});

test("replaces a broken rule link without a backup", () => {
  const { home } = createFixture();
  mkdirSync(join(home, ".codex"), { recursive: true });
  symlinkSync("../missing/AGENTS.md", join(home, ".codex/AGENTS.md"));

  runWrapper(home);

  assertManagedRules(home);
  assert.equal(
    readdirSync(join(home, ".codex")).some((name) => name.includes(".backup.")),
    false,
  );
});

test("replaces conflicting rule links without backups", () => {
  const { home, root } = createFixture();
  const externalRules = join(root, "external/rules.md");
  mkdirSync(dirname(externalRules), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(externalRules, "external fixture rules\n");
  symlinkSync(externalRules, join(home, ".claude/CLAUDE.md"));
  symlinkSync(externalRules, join(home, ".codex/AGENTS.md"));

  runWrapper(home);

  assertManagedRules(home);
  for (const directory of [".claude", ".codex"]) {
    assert.equal(
      readdirSync(join(home, directory)).some((name) => name.includes(".backup.")),
      false,
    );
  }
});

test("does not replace managed rule paths again", () => {
  const { home } = createFixture();

  runWrapper(home);
  const output = runWrapper(home);

  assertManagedRules(home);
  assert.doesNotMatch(output, /removed conflicting generated agent rules/);
  assert.equal(
    readdirSync(home).some((name) => name.startsWith("AGENTS.md.backup.")),
    false,
  );
  assert.equal(
    readdirSync(join(home, ".claude")).some((name) => name.includes(".backup.")),
    false,
  );
  assert.equal(
    readdirSync(join(home, ".codex")).some((name) => name.includes(".backup.")),
    false,
  );
});
