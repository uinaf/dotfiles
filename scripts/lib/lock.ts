// Cooperative directory locks for unattended maintenance jobs.
// This module must stay dependency-free: converge.ts acquires its lock before
// the checkout's locked dependencies are installed.
import { mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";

const ownerFileName = "owner.json";
// os.uptime() rounds independently in each process; only a clearly earlier boot marks a stale owner.
const bootSkewMs = 120_000;
const initialRetryDelayMs = 5_000;
const maxRetryDelayMs = 60_000;

export type LockProbe = {
  readonly now?: () => number;
  readonly uptimeMs?: () => number;
  readonly processAlive?: (pid: number) => boolean;
};

export type LockOptions = LockProbe & {
  readonly waitMs?: number;
  readonly sleep?: (ms: number) => void;
  readonly log?: (message: string) => void;
};

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists under another Unix user (the devbox checkout
    // lock is shared across users); only ESRCH proves the recorded owner is gone.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// Fail closed: unreadable, malformed, or partial owner metadata keeps the lock.
export function lockOwnerAlive(lock: string, probe: LockProbe = {}): boolean {
  let metadata: unknown;
  try {
    metadata = JSON.parse(readFileSync(join(lock, ownerFileName), "utf8"));
  } catch {
    return true;
  }
  if (typeof metadata !== "object" || metadata === null) return true;
  const { pid, bootTime } = metadata as { pid?: unknown; bootTime?: unknown };
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return true;
  if (typeof bootTime !== "number" || !Number.isFinite(bootTime)) return true;
  const currentBoot = (probe.now?.() ?? Date.now()) - (probe.uptimeMs?.() ?? uptime() * 1000);
  // Recorded before the current boot: the pid belongs to an unrelated process by now.
  if (bootTime < currentBoot - bootSkewMs) return false;
  return (probe.processAlive ?? processAlive)(pid);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Create `lock`, recording this process as its owner. A held lock whose recorded
// owner is provably gone (dead pid or pre-boot metadata) is reclaimed once;
// remaining contention retries with backoff until `waitMs` elapses, then fails loudly.
export function acquireDirectoryLock(lock: string, options: LockOptions = {}): () => void {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepSync;
  const log = options.log ?? ((message: string) => { console.error(message); });
  const deadline = now() + (options.waitMs ?? 0);
  let reclaimed = false;
  let announced = false;
  let delay = initialRetryDelayMs;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      if (!reclaimed && !lockOwnerAlive(lock, options)) {
        reclaimed = true;
        log(`reclaiming stale lock left by a dead process: ${lock}`);
        // A concurrent acquirer can win this race; the next iteration observes either outcome.
        try {
          rmSync(join(lock, ownerFileName), { force: true });
          rmdirSync(lock);
        } catch {
          // Raced away or unexpectedly non-empty; the normal contention path decides below.
        }
        continue;
      }
      const remaining = deadline - now();
      if (remaining <= 0) throw new Error(`lock is held by an active process: ${lock}`);
      if (!announced) {
        announced = true;
        log(`waiting up to ${Math.ceil(remaining / 60_000)} minutes for ${lock}`);
      }
      sleep(Math.min(delay, remaining));
      delay = Math.min(delay * 2, maxRetryDelayMs);
      continue;
    }
    const owner = join(lock, ownerFileName);
    const metadata = { pid: process.pid, bootTime: now() - (options.uptimeMs?.() ?? uptime() * 1000) };
    try {
      writeFileSync(owner, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
    } catch (cause) {
      try {
        rmdirSync(lock);
      } catch {
        // Keep the original failure; the empty directory stays for inspection.
      }
      throw cause;
    }
    return () => {
      rmSync(owner, { force: true });
      rmdirSync(lock);
    };
  }
}
