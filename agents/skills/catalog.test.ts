import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vite-plus/test";
import { readLayeredSkills, readSkillLock } from "./catalog.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "skill-catalog-"));
  roots.push(root);
  mkdirSync(join(root, "agents/skills"), { recursive: true });
  for (const layer of ["developer", "workstation", "devbox", "personal"])
    writeFileSync(join(root, `agents/skills/${layer}.json`), '{"skills":[]}');
  return root;
}

function manifest(root: string, layer: string, source: string) {
  writeFileSync(
    join(root, `agents/skills/${layer}.json`),
    JSON.stringify({
      skills: [{ name: "example", source }],
    }),
  );
}

test("composed skills deduplicate identical declarations and reject conflicting sources", () => {
  const root = fixture();
  manifest(root, "developer", "example/skills");
  manifest(root, "workstation", "example/skills");
  assert.deepEqual(readLayeredSkills(root, "workstation", ["developer", "workstation"]).skills, [
    { name: "example", source: "example/skills" },
  ]);
  manifest(root, "workstation", "example/different");
  assert.throws(
    () => readLayeredSkills(root, "workstation", ["developer", "workstation"]),
    /defined more than once/,
  );
});

test("catalog validates unselected manifests before composing selected layers", () => {
  const root = fixture();
  writeFileSync(join(root, "agents/skills/personal.json"), '{"skills":[{"name":"invalid"}]}');
  assert.throws(
    () => readLayeredSkills(root, "developer", ["developer"]),
    /Invalid skills manifest/,
  );
});

test("skill ownership reads reject duplicate entries and unsupported versions", () => {
  const root = fixture();
  const path = join(root, "agents/skills.lock.json");
  assert.equal(readSkillLock(path), undefined);
  const skill = { name: "example", source: "example/skills" };
  writeFileSync(path, JSON.stringify({ version: 1, skills: [skill, skill] }));
  assert.throws(() => readSkillLock(path), /must be unique/);
  writeFileSync(path, JSON.stringify({ version: 2, skills: [skill] }));
  assert.throws(() => readSkillLock(path), /expected version 1/);
});
