import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { errorMessage } from "./runtime.ts";

export function migrateLegacyLock(repo: string, name: "skills" | "plugins" | "mcps"): string {
  const destination = join(repo, "agents", `${name}.lock.json`);
  const legacyDirectory = join(repo, "scripts", "agents");
  for (const directory of [join(repo, "scripts"), legacyDirectory, dirname(destination)]) {
    const info = lstatSync(directory, { throwIfNoEntry: false });
    if (info && !info.isDirectory()) throw new Error(`Lock directory must not be a symlink or file: ${directory}`);
  }
  const legacy = join(legacyDirectory, `${name}.lock.json`);
  const source = lstatSync(legacy, { throwIfNoEntry: false });
  if (!source) return destination;
  if (!source.isFile() || source.uid !== process.getuid?.() || (source.mode & 0o077) !== 0) {
    throw new Error(`Legacy managed lock must be an owner-only regular file: ${legacy}`);
  }
  const target = lstatSync(destination, { throwIfNoEntry: false });
  if (target) {
    // Recover an interruption between creating the new name and removing the old one.
    if (target.isFile() && target.dev === source.dev && target.ino === source.ino) {
      unlinkSync(legacy);
      return destination;
    }
    throw new Error(`Both legacy and current managed locks exist; reconcile them before syncing: ${legacy}, ${destination}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  // link is exclusive: a concurrent sync cannot have its ownership state overwritten.
  linkSync(legacy, destination);
  unlinkSync(legacy);
  return destination;
}

export function readLockFile(lockPath: string, label: string): unknown | undefined {
  if (!existsSync(lockPath)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid managed ${label} lock at ${lockPath}: ${errorMessage(error)}`);
  }
}

export function writeLockFile(lockPath: string, value: unknown): void {
  mkdirSync(dirname(lockPath), { recursive: true });
  const temporaryDirectory = mkdtempSync(join(dirname(lockPath), ".lock-"));
  const temporaryLock = join(temporaryDirectory, "lock.json");

  try {
    writeFileSync(temporaryLock, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryLock, lockPath);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}
