#!/usr/bin/env node

import assert from "node:assert/strict";
import { Console, Effect } from "effect";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runMain } from "../lib/program.ts";

import { readProfileModel } from "../profiles/model.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceDir = resolve(repoRoot, "chezmoi");
export const profiles = Object.keys(readProfileModel(join(sourceDir, ".chezmoidata/profiles.json")).profiles);

export function runApply(profile: string, fixtureRoot: string): Promise<void> {
  const paths = {
    home: join(fixtureRoot, "home"),
    config: join(fixtureRoot, "xdg/config"),
    cache: join(fixtureRoot, "xdg/cache"),
    data: join(fixtureRoot, "xdg/data"),
    state: join(fixtureRoot, "xdg/state"),
    temp: join(fixtureRoot, "tmp"),
    git: join(fixtureRoot, "gitconfig"),
  };
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.temp, { recursive: true });

  for (const path of Object.values(paths)) {
    assert.ok(resolve(path).startsWith(`${resolve(fixtureRoot)}/`));
  }

  return new Promise((finish, reject) => {
    const data = JSON.stringify({ dotfilesProfile: profile });
    const child = spawn("chezmoi", [
      "--source",
      sourceDir,
      "--destination",
      paths.home,
      "--override-data",
      data,
      "--force",
      "apply",
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: paths.home,
        XDG_CONFIG_HOME: paths.config,
        XDG_CACHE_HOME: paths.cache,
        XDG_DATA_HOME: paths.data,
        XDG_STATE_HOME: paths.state,
        TMPDIR: paths.temp,
        GIT_CONFIG_GLOBAL: paths.git,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      if (status !== 0) {
        reject(new Error(Buffer.concat(output).toString()));
        return;
      }
      const storedProfile = readFileSync(join(paths.home, ".config/dotfiles/profile"), "utf8").trim();
      assert.equal(storedProfile, profile);
      assert.ok(realpathSync(paths.home).startsWith(`${realpathSync(fixtureRoot)}/`));
      finish();
    });
  });
}

export async function verifyProfiles(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-homes-"));
  try {
    const results = await Promise.allSettled(
      profiles.map((profile) => runApply(profile, join(root, profile))),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      throw failure.reason;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runMain(Effect.tryPromise({ try: verifyProfiles, catch: (error) => error }).pipe(
    Effect.tap(() => Console.log("ok all profiles apply in disposable homes")),
  ));
}
