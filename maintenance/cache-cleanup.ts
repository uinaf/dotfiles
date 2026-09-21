import { DateTime, Effect, FileSystem, Option } from "effect";
import { isAbsolute, join } from "node:path";
import { commandAvailable } from "../lib/command-available.ts";
import { CommandRunner } from "../lib/command.ts";

export const cacheCleanupTimeoutMs = 30 * 60_000;

const caches = [
  ["Library/Developer/Xcode/DerivedData", 30],
  ["Library/Developer/CoreSimulator/Caches", 30],
  ["Library/Logs/CoreSimulator", 14],
  [".gradle/caches/build-cache-1", 30],
  [".gradle/daemon", 14],
  ["Library/Caches/go-build", 30],
  ["Library/Logs/DiagnosticReports", 30],
] as const;

// Codex entries name session subtrees, never the Codex root: that root holds
// config, skills, memories, and the sqlite databases owning live state. Codex
// synchronises curated plugins through lock files under `.tmp`, so those stay.
const codexCaches = [
  ["archived_sessions", 30, undefined],
  ["sessions", 90, undefined],
  ["visualizations", 30, undefined],
  [".tmp", 7, "*.lock"],
] as const;

// Codex honours CODEX_HOME over the Unix home directory; hygiene must clean the
// same tree Codex writes to. Empty and relative values fall back rather than
// resolving against the working directory, where they would name siblings of
// the real cache roots and delete them.
const codexHome = (home: string) => {
  const configured = process.env.CODEX_HOME;
  return configured && isAbsolute(configured) ? configured : join(home, ".codex");
};

export const cacheCleanup = Effect.fn("cacheCleanup")(function* (
  home: string,
  apply: boolean,
  timeoutMs = cacheCleanupTimeoutMs,
) {
  const runner = yield* CommandRunner;
  const fs = yield* FileSystem.FileSystem;
  const lines: string[] = [];
  let failed = false;
  const log = Effect.fn("cacheCleanup.log")(function* (message: string) {
    lines.push(`${DateTime.formatIso(yield* DateTime.now)} cache-cleanup ${message}`);
  });
  const command = Effect.fn("cacheCleanup.command")(function* (
    name: string,
    args: readonly string[],
  ) {
    return yield* runner
      .run(name, args, {
        cwd: home,
        output: "capture",
        env: { HOME: home, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      })
      .pipe(Effect.catch(() => Effect.succeed({ status: 1, stdout: "", stderr: "" })));
  });
  const checked = Effect.fn("cacheCleanup.checked")(function* (
    name: string,
    args: readonly string[],
  ) {
    const result = yield* command(name, args);
    if (result.status !== 0) {
      failed = true;
      yield* log(`warning: failed: ${name}`);
    }
    return result;
  });
  const mutate = Effect.fn("cacheCleanup.mutate")(function* (
    name: string,
    args: readonly string[],
  ) {
    if (!apply) return yield* log(`dry-run: ${[name, ...args].join(" ")}`);
    yield* checked(name, args);
  });
  const used = Effect.fn("cacheCleanup.used")(function* () {
    const volume = (yield* fs.exists("/System/Volumes/Data")) ? "/System/Volumes/Data" : "/";
    const result = yield* checked("df", ["-k", volume]);
    const value = Number(result.stdout.trim().split("\n")[1]?.trim().split(/\s+/)[2]);
    if (Number.isFinite(value)) return value;
    failed = true;
    yield* log("warning: disk usage unavailable");
    return undefined;
  });
  const gigabytes = (value: number | undefined) =>
    value === undefined ? "unknown" : `${(value / 1048576).toFixed(1)}G`;
  const cleanup = Effect.gen(function* () {
    const before = yield* used();
    yield* log(`start used=${gigabytes(before)} dry_run=${apply ? 0 : 1}`);
    const targets: readonly (readonly [string, number, string | undefined])[] = [
      ...caches.map(([relative, days]) => [join(home, relative), days, undefined] as const),
      ...codexCaches.map(
        ([relative, days, keep]) => [join(codexHome(home), relative), days, keep] as const,
      ),
    ];
    for (const [path, days, keep] of targets) {
      const info = yield* fs.stat(path).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "Directory") continue;
      yield* log(`prune files older than ${days} days under ${path}`);
      const result = yield* checked("find", [
        path,
        "-type",
        "f",
        ...(keep === undefined ? [] : ["!", "-name", keep]),
        "-mtime",
        `+${days}`,
        apply ? "-delete" : "-print0",
      ]);
      // -mindepth 1 keeps the cache root itself when every file under it expired.
      if (apply)
        yield* checked("find", [path, "-mindepth", "1", "-type", "d", "-empty", "-delete"]);
      else lines.push(`  would remove ${result.stdout.split("\0").filter(Boolean).length} files`);
    }
    if (
      (yield* commandAvailable("xcrun")) &&
      (yield* command("xcrun", ["--find", "simctl"])).status === 0
    ) {
      yield* log("delete unavailable simulators");
      yield* mutate("xcrun", ["simctl", "delete", "unavailable"]);
    }
    if (yield* commandAvailable("pnpm")) {
      yield* log("pnpm store prune");
      yield* mutate("pnpm", ["store", "prune"]);
    }
    if ((yield* commandAvailable("docker")) && (yield* command("docker", ["info"])).status === 0) {
      yield* log("docker build cache older than 7 days");
      yield* mutate("docker", ["builder", "prune", "-f", "--filter", "until=168h"]);
    }
    const after = yield* used();
    yield* log(
      `done used=${gigabytes(after)} freed=${gigabytes(before === undefined || after === undefined ? undefined : before - after)}`,
    );
  });
  yield* cleanup.pipe(
    Effect.timeout(timeoutMs),
    Effect.catchTag("TimeoutError", () =>
      Effect.gen(function* () {
        failed = true;
        yield* log(`warning: cleanup timed out after ${timeoutMs}ms`);
      }),
    ),
  );
  return { status: failed ? 1 : 0, stdout: lines.join("\n") + "\n" };
});
