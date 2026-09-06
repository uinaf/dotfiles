import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { pruneOlderBackups } from "./apply-dotfiles.ts";

test("only the most recent timestamped backup per target survives pruning", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dotfiles-backups-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "local.dotfiles.software-update.plist");
  await writeFile(target, "managed content");
  await writeFile(`${target}.backup.20240101010101`, "oldest");
  await mkdir(`${target}.backup.20250101010101`); // a backed-up directory is removed recursively
  await symlink(target, `${target}.backup.20250601010101`);
  await writeFile(`${target}.backup.20260101010101`, "newest");
  await writeFile(`${target}.backup.notatimestamp`, "unrelated suffix");
  await writeFile(join(root, "other.plist.backup.20200101010101"), "different target");
  await Effect.runPromise(pruneOlderBackups(target).pipe(Effect.provide(NodeServices.layer)));
  assert.deepEqual((await readdir(root)).sort(), [
    "local.dotfiles.software-update.plist",
    "local.dotfiles.software-update.plist.backup.20260101010101",
    "local.dotfiles.software-update.plist.backup.notatimestamp",
    "other.plist.backup.20200101010101",
  ]);
});

test("a single backup and a backup-free target are left untouched", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dotfiles-backups-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "config");
  await writeFile(target, "managed content");
  await Effect.runPromise(pruneOlderBackups(target).pipe(Effect.provide(NodeServices.layer)));
  await writeFile(`${target}.backup.20260101010101`, "only backup");
  await Effect.runPromise(pruneOlderBackups(target).pipe(Effect.provide(NodeServices.layer)));
  assert.deepEqual((await readdir(root)).sort(), ["config", "config.backup.20260101010101"]);
});
