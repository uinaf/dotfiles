import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, truncateSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const day = 86_400_000;

export function logDirectory(home: string): string {
  const directory = join(home, "Library/Logs/dotfiles");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

export function pruneLogs(directory: string, now = Date.now()): void {
  const cutoff = new Date(now - 6 * day).toISOString().slice(0, 10);
  for (const name of readdirSync(directory)) {
    const date = /^(?:software-update|homebrew-update|hygiene)(?:-history)?-(\d{4}-\d{2}-\d{2})(?:T[\d.-]+Z)?\.log$/.exec(name)?.[1];
    const path = join(directory, name);
    if (date && date < cutoff && lstatSync(path).isFile()) unlinkSync(path);
  }
}

export function dailyLog(home: string, name: "software-update-history" | "homebrew-update-history" | "hygiene", now = Date.now()): string {
  const directory = logDirectory(home);
  pruneLogs(directory, now);
  return join(directory, `${name}-${new Date(now).toISOString().slice(0, 10)}.log`);
}

export function rotateUpdateLog(home: string, job: "software-update" | "homebrew-update", now = Date.now()): void {
  const directory = logDirectory(home);
  const path = join(directory, `${job}.log`);
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (!info.isFile()) throw new Error("update log must be a regular file");
    if (info.size > 0) {
      const timestamp = info.mtime.toISOString().replaceAll(":", "-");
      copyFileSync(path, join(directory, `${job}-${timestamp}.log`));
      // launchd already holds this inode open for append in the new run.
      truncateSync(path, 0);
    }
  }
  pruneLogs(directory, now);
}
