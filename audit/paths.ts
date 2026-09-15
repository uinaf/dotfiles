import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export type PathSource =
  | { kind: "path"; path: string }
  | { kind: "home-dotfiles"; exclude?: readonly string[] }
  | { kind: "files"; path: string; maxDepth?: number; namePrefix?: string; pathPattern?: RegExp };

export function homePath(home: string, path: string): string {
  return path.startsWith("/") ? path : join(home, path);
}

export function walkFiles(root: string, maxDepth = Number.POSITIVE_INFINITY, depth = 0): string[] {
  if (!existsSync(root)) return [];
  if (!statSync(root).isDirectory()) return [root];
  if (depth > maxDepth) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() && depth < maxDepth
      ? walkFiles(path, maxDepth, depth + 1)
      : entry.isFile()
        ? [path]
        : [];
  });
}

export function resolveSources(home: string, sources: readonly PathSource[]): string[] {
  const paths = sources.flatMap((source) => {
    if (source.kind === "path") {
      const path = homePath(home, source.path);
      return existsSync(path) ? [path] : [];
    }
    if (source.kind === "home-dotfiles") {
      const excluded = new Set(source.exclude ?? []);
      return readdirSync(home, { withFileTypes: true })
        .filter(
          (entry) => entry.isFile() && entry.name.startsWith(".") && !excluded.has(entry.name),
        )
        .map((entry) => join(home, entry.name));
    }
    const root = homePath(home, source.path);
    return walkFiles(root, source.maxDepth ?? Number.POSITIVE_INFINITY)
      .filter(
        (path) => source.namePrefix === undefined || basename(path).startsWith(source.namePrefix),
      )
      .filter((path) => source.pathPattern === undefined || source.pathPattern.test(path));
  });
  return [...new Set(paths)].sort();
}
