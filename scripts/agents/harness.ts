import { type SkillLayer } from "../profiles/model.ts";
import { type Runtime, writeLine } from "./runtime.ts";

// Claude must precede cursor and opencode: their skill links resolve into the
// Claude marketplace checkout that Claude's own sync creates and updates.
export const HARNESSES = ["claude", "codex", "cursor", "grok", "opencode"] as const;

export type Harness = (typeof HARNESSES)[number];

export const HARNESS_INFO: Record<Harness, { binary: string; label: string }> = {
  claude: { binary: "claude", label: "Claude Code" },
  codex: { binary: "codex", label: "Codex" },
  cursor: { binary: "cursor-agent", label: "Cursor" },
  grok: { binary: "grok", label: "Grok" },
  opencode: { binary: "opencode", label: "OpenCode" },
};

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export function isSafeName(value: string): boolean {
  return NAME_PATTERN.test(value) && !RESERVED_NAMES.has(value);
}

export function isHarness(value: unknown): value is Harness {
  return typeof value === "string" && (HARNESSES as readonly string[]).includes(value);
}

// Selection uses membership, never order; normalize so composition compares
// manifests by meaning rather than authoring order.
export function readHarnesses(value: unknown, invalidMessage: string): readonly Harness[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(isHarness) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(invalidMessage);
  }
  return HARNESSES.filter((harness) => value.includes(harness));
}

export function harnessPresent(runtime: Runtime): boolean {
  return HARNESSES.some((harness) => runtime.commandExists(HARNESS_INFO[harness].binary));
}

export type SyncFailure = {
  diagnostic: string;
  summary: string;
};

export function reportSyncFailures(
  runtime: Runtime,
  failures: readonly SyncFailure[],
  subject: string,
  nouns: readonly [string, string],
  kind: string,
): 1 {
  const noun = failures.length === 1 ? nouns[0] : nouns[1];
  writeLine(runtime.stderr, `${subject} failed for ${failures.length} ${noun}:`);
  for (const failure of failures) {
    writeLine(runtime.stderr, `  - ${failure.summary}`);
    for (const line of failure.diagnostic.split("\n")) {
      if (line.length > 0) {
        writeLine(runtime.stderr, `    ${line}`);
      }
    }
  }
  writeLine(runtime.stderr, `Fix the reported ${kind} failures, then rerun sync.`);
  return 1;
}

export type SyncArgs =
  | { kind: "run"; profile?: string; update: boolean }
  | { kind: "help" }
  | { kind: "error"; message: string };

export function parseSyncArgs(args: readonly string[], usage: string, allowUpdate: boolean): SyncArgs {
  let profile: string | undefined;
  let update = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (allowUpdate && arg === "--update") {
      update = true;
      continue;
    }
    if (arg === "--profile") {
      if (profile !== undefined) {
        return { kind: "error", message: `${usage}\n--profile may be provided only once` };
      }
      const value = args[index + 1];
      if (value === undefined) {
        return { kind: "error", message: `${usage}\n--profile requires a value` };
      }
      profile = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { kind: "help" };
    }
    return { kind: "error", message: `${usage}\nUnknown argument: ${arg}` };
  }

  return { kind: "run", profile, update };
}

// Compose the selected manifest layers, tolerating an identical entry selected
// by more than one layer and rejecting a conflicting redefinition.
export function composeLayers<T>(
  selected: readonly SkillLayer[],
  manifests: ReadonlyMap<SkillLayer, readonly T[]>,
  keyOf: (entry: T) => string,
  conflictMessage: (key: string) => string,
): T[] {
  const seen = new Map<string, string>();
  const entries: T[] = [];
  for (const entry of selected.flatMap((layer) => manifests.get(layer) ?? [])) {
    const key = keyOf(entry);
    const shape = JSON.stringify(entry);
    const previous = seen.get(key);
    if (previous === shape) {
      continue;
    }
    if (previous !== undefined) {
      throw new Error(conflictMessage(key));
    }
    seen.set(key, shape);
    entries.push(entry);
  }
  return entries;
}

// Ownership-lock algebra shared by the plugin and MCP syncs. Each lock entry
// records the harness subset the sync owns for one named thing; apply drops
// stale ownership, keeps ownership for absent CLIs, and merges the remainder.
export type HarnessOwned = { harnesses: readonly Harness[] };

export function staleEntries<P extends HarnessOwned, C extends HarnessOwned>(
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

export function presentHarnessEntries<T extends HarnessOwned>(
  runtime: Runtime,
  entries: readonly T[],
): T[] {
  return entries
    .map((entry) => ({
      ...entry,
      harnesses: entry.harnesses.filter((harness) =>
        runtime.commandExists(HARNESS_INFO[harness].binary),
      ),
    }))
    .filter((entry) => entry.harnesses.length > 0);
}

export function retainAbsentEntries<P extends HarnessOwned, C extends HarnessOwned>(
  runtime: Runtime,
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
      (harness) =>
        next.harnesses.includes(harness) &&
        !runtime.commandExists(HARNESS_INFO[harness].binary),
    );
    if (absent.length > 0) {
      leftover.push({ ...owned, harnesses: absent });
    }
  }

  return leftover;
}

export function mergeLockEntries<T extends HarnessOwned>(
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
