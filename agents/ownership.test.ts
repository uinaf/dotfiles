import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { type Harness } from "./harness.ts";
import { planOwnership } from "./ownership.ts";

type Entry = { name: string; harnesses: readonly Harness[] };
const keyOf = (entry: Entry) => entry.name;

test("deferred ownership survives a missing harness and is removed when it returns", () => {
  const previous: Entry[] = [
    { name: "retired", harnesses: ["claude", "codex"] },
    { name: "retained", harnesses: ["claude", "codex"] },
  ];
  const selected: Entry[] = [
    { name: "retained", harnesses: ["claude", "codex"] },
    { name: "new", harnesses: ["claude", "codex"] },
  ];
  const original = structuredClone({ previous, selected });
  const first = planOwnership({ previous, selected, available: ["claude"], keyOf });
  assert.deepEqual(first.removals, [previous[0]]);

  const deferred: Entry[] = [{ name: "retired", harnesses: ["codex"] }];
  const lock = first.nextLock(deferred);
  assert.deepEqual(lock, [
    { name: "retained", harnesses: ["claude", "codex"] },
    { name: "new", harnesses: ["claude"] },
    { name: "retired", harnesses: ["codex"] },
  ]);

  const retry = planOwnership({
    previous: lock,
    selected,
    available: ["claude", "codex"],
    keyOf,
  });
  assert.deepEqual(retry.removals, deferred);
  assert.deepEqual(retry.nextLock([]), selected);
  assert.deepEqual(first.nextLock(deferred), lock);
  assert.deepEqual({ previous, selected }, original);
});
