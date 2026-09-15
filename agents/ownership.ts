import { type Harness, HARNESSES } from "./harness.ts";

// Ownership-lock algebra shared by the plugin and MCP syncs. Each lock entry
// records the harness subset the sync owns for one named thing; apply drops
// stale ownership, keeps ownership for absent CLIs, and merges the remainder.
type HarnessOwned = { harnesses: readonly Harness[] };

function staleEntries<P extends HarnessOwned, C extends HarnessOwned>(
  previous: readonly P[],
  current: readonly C[],
  keyOf: (entry: P | C) => string,
  extraDropped?: (owned: P, next: C) => readonly Harness[],
): P[] {
  const currentByKey = new Map(current.map((entry) => [keyOf(entry), entry]));
  const stale: P[] = [];

  for (const owned of previous) {
    const next = currentByKey.get(keyOf(owned));
    if (next === undefined) {
      stale.push(owned);
      continue;
    }
    const dropped = owned.harnesses.filter((harness) => !next.harnesses.includes(harness));
    for (const harness of extraDropped?.(owned, next) ?? []) {
      if (!dropped.includes(harness)) {
        dropped.push(harness);
      }
    }
    if (dropped.length > 0) {
      stale.push({ ...owned, harnesses: dropped });
    }
  }

  return stale;
}

function presentHarnessEntries<T extends HarnessOwned>(
  available: readonly Harness[],
  entries: readonly T[],
): T[] {
  return entries
    .map((entry) => ({
      ...entry,
      harnesses: entry.harnesses.filter((harness) => available.includes(harness)),
    }))
    .filter((entry) => entry.harnesses.length > 0);
}

function retainAbsentEntries<P extends HarnessOwned, C extends HarnessOwned>(
  available: readonly Harness[],
  previous: readonly P[],
  current: readonly C[],
  keyOf: (entry: P | C) => string,
): P[] {
  const currentByKey = new Map(current.map((entry) => [keyOf(entry), entry]));
  const leftover: P[] = [];

  for (const owned of previous) {
    const next = currentByKey.get(keyOf(owned));
    if (next === undefined) {
      continue;
    }
    const absent = owned.harnesses.filter(
      (harness) => next.harnesses.includes(harness) && !available.includes(harness),
    );
    if (absent.length > 0) {
      leftover.push({ ...owned, harnesses: absent });
    }
  }

  return leftover;
}

function mergeLockEntries<T extends HarnessOwned>(
  current: readonly T[],
  leftover: readonly T[],
  keyOf: (entry: T) => string,
  mergeExtra?: (existing: T, extra: T) => void,
): T[] {
  const byKey = new Map(
    current.map((entry) => [keyOf(entry), { ...entry, harnesses: [...entry.harnesses] }]),
  );

  for (const extra of leftover) {
    const existing = byKey.get(keyOf(extra));
    if (existing === undefined) {
      byKey.set(keyOf(extra), { ...extra, harnesses: [...extra.harnesses] });
      continue;
    }
    existing.harnesses = HARNESSES.filter(
      (harness) => existing.harnesses.includes(harness) || extra.harnesses.includes(harness),
    );
    mergeExtra?.(existing, extra);
  }

  return [...byKey.values()];
}

// Inputs are validated manifest/lock entries. Persist nextLock only after all
// apply/remove operations succeed; deferred removals remain owned for retry.
export function planOwnership<T extends HarnessOwned>(options: {
  previous: readonly T[];
  selected: readonly T[];
  available: readonly Harness[];
  keyOf: (entry: T) => string;
  extraDropped?: (owned: T, next: T) => readonly Harness[];
  mergeExtra?: (existing: T, deferred: T) => void;
}): { removals: T[]; nextLock: (deferred: readonly T[]) => T[] } {
  const { previous, selected, available, keyOf, extraDropped, mergeExtra } = options;
  const applied = presentHarnessEntries(available, selected);
  const retained = retainAbsentEntries(available, previous, selected, keyOf);
  return {
    removals: staleEntries(previous, selected, keyOf, extraDropped),
    nextLock: (deferred) =>
      mergeLockEntries(applied, [...deferred, ...retained], keyOf, mergeExtra),
  };
}
