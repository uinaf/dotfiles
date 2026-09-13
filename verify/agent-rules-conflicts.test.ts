import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import {
  assertManagedRules,
  cleanupFixtures,
  createFixture,
  runWrapper,
} from "./agent-rules-fixture.ts";

afterEach(cleanupFixtures);

test("ignores the retired agents.local.md path", () => {
  const { home } = createFixture();
  const retiredRules = join(home, ".config/dotfiles/agents.local.md");
  mkdirSync(dirname(retiredRules), { recursive: true });
  writeFileSync(retiredRules, "# Retired fixture rules\n");
  chmodSync(retiredRules, 0o600);

  runWrapper(home);

  assert.doesNotMatch(assertManagedRules(home), /Retired fixture rules/);
});

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
  assert.equal(readdirSync(join(home, ".claude")).some((name) => name.includes(".backup.")), false);
});

test("replaces a conflicting home rule file without a backup", () => {
  const { home } = createFixture();
  writeFileSync(join(home, "AGENTS.md"), "unmanaged Cursor rules\n");

  runWrapper(home);

  assertManagedRules(home);
  assert.equal(readdirSync(home).some((name) => name.startsWith("AGENTS.md.backup.")), false);
});

test("removes the retired rule file without a backup or removing installed skills", () => {
  const { home } = createFixture();
  const installedSkill = join(home, ".agents/skills/example/SKILL.md");
  mkdirSync(dirname(installedSkill), { recursive: true });
  writeFileSync(join(home, ".agents/AGENTS.md"), "retired shared rules\n");
  writeFileSync(installedSkill, "installed skill\n");

  runWrapper(home);

  assertManagedRules(home);
  assert.equal(readdirSync(join(home, ".agents")).includes("AGENTS.md"), false);
  assert.equal(readdirSync(join(home, ".agents")).some((name) => name.includes(".backup.")), false);
  assert.equal(readFileSync(installedSkill, "utf8"), "installed skill\n");
});

test("replaces a broken rule link without a backup", () => {
  const { home } = createFixture();
  mkdirSync(join(home, ".codex"), { recursive: true });
  symlinkSync("../missing/AGENTS.md", join(home, ".codex/AGENTS.md"));

  runWrapper(home);

  assertManagedRules(home);
  assert.equal(readdirSync(join(home, ".codex")).some((name) => name.includes(".backup.")), false);
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
    assert.equal(readdirSync(join(home, directory)).some((name) => name.includes(".backup.")), false);
  }
});

test("does not replace managed rule paths again", () => {
  const { home } = createFixture();

  runWrapper(home);
  const output = runWrapper(home);

  assertManagedRules(home);
  assert.doesNotMatch(output, /removed conflicting generated agent rules/);
  assert.equal(readdirSync(home).some((name) => name.startsWith("AGENTS.md.backup.")), false);
  assert.equal(readdirSync(join(home, ".claude")).some((name) => name.includes(".backup.")), false);
  assert.equal(readdirSync(join(home, ".codex")).some((name) => name.includes(".backup.")), false);
});
