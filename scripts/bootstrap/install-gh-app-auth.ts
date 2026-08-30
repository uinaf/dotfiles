#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option, Schema } from "effect";
import { join } from "node:path";
import { CommandRunner, runChecked } from "../lib/command.ts";
import { CliFailure, fail, runMain } from "../lib/program.ts";

const sourceCommit = process.env.GH_APP_AUTH_SOURCE_COMMIT || "620f73d8e27a81ea5736acbf5643b461da61c0f4";
const sourceUrl = process.env.GH_APP_AUTH_SOURCE_URL || `https://codeload.github.com/AmadeusITGroup/gh-app-auth/tar.gz/${sourceCommit}`;
const sourceSha256 = process.env.GH_APP_AUTH_SOURCE_SHA256 || "c4d80ff42526308bd27fc8b458e2c256bfced14cf6d90c4ce28afa3aa5ccbae3";
const goVersion = process.env.GH_APP_AUTH_GO_VERSION || "1.26.6";
const canonicalInstallDir = join(process.env.HOME || "", ".local/share/gh/extensions/gh-app-auth");
const installDir = process.env.GH_APP_AUTH_INSTALL_DIR || canonicalInstallDir;
const binary = join(installDir, "gh-app-auth");
const marker = join(installDir, ".dotfiles-source");
const expectedMarker = `commit=${sourceCommit}\nsource_sha256=${sourceSha256}\ngo=${goVersion}`;
const Sha256 = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)));

const run = Effect.fn("runGhAppAuthInstallCommand")(function*(
  command: string,
  args: readonly string[],
  options: { readonly env?: Readonly<Record<string, string>>; readonly output?: "capture" | "inherit"; readonly cwd?: string } = {},
) {
  return yield* runChecked(command, args, options);
});

const verifyInstall = Effect.fn("verifyGhAppAuthInstall")(function*() {
  yield* run(binary, ["exec", "--help"]);
  if (installDir === canonicalInstallDir) {
    yield* run("gh", ["app-auth", "exec", "--help"], {
      env: { GH_NO_EXTENSION_UPDATE_NOTIFIER: "1" },
    }).pipe(
      Effect.mapError(() => new CliFailure({ exitCode: 1, message: "GitHub CLI cannot execute the gh-app-auth extension" })),
    );
  }
});

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const binaryInfo = yield* fs.stat(binary).pipe(Effect.option);
  const markerInfo = yield* fs.stat(marker).pipe(Effect.option);
  const markerContents = yield* fs.readFileString(marker).pipe(Effect.option);
  if (
    Option.isSome(binaryInfo) &&
    binaryInfo.value.type === "File" &&
    (binaryInfo.value.mode & 0o111) !== 0 &&
    Option.isSome(markerInfo) &&
    markerInfo.value.type === "File" &&
    Option.getOrUndefined(markerContents)?.trimEnd() === expectedMarker
  ) {
    yield* verifyInstall();
    yield* Console.log(`ok gh-app-auth is already installed at ${binary}`);
    return;
  }

  yield* Effect.scoped(Effect.gen(function*() {
    const runtimeDir = yield* fs.makeTempDirectoryScoped({ prefix: "gh-app-auth-install." });
    const archive = join(runtimeDir, "source.tar.gz");
    const sourceDir = join(runtimeDir, "source");
    const builtBinary = join(runtimeDir, "gh-app-auth");
    const markerFile = join(runtimeDir, "source-marker");

    yield* Console.log(`fetching gh-app-auth source at ${sourceCommit}`);
    yield* run("curl", ["--fail", "--location", "--silent", "--show-error", "--retry", "3", sourceUrl, "--output", archive]);
    const checksum = yield* run("shasum", ["-a", "256", archive]);
    const checksumToken = checksum.stdout.trim().split(/\s+/)[0];
    const actualSha256 = yield* Schema.decodeUnknownEffect(Sha256)(checksumToken).pipe(
      Effect.mapError(() => new CliFailure({ exitCode: 1, message: "shasum returned an invalid SHA-256 digest" })),
    );
    if (actualSha256 !== sourceSha256) {
      return yield* fail(`gh-app-auth source checksum mismatch: expected ${sourceSha256}, got ${actualSha256}`);
    }

    yield* fs.makeDirectory(sourceDir, { recursive: true });
    yield* run("tar", ["-xzf", archive, "-C", sourceDir, "--strip-components=1"]);
    yield* Console.log(`building gh-app-auth with temporary Go ${goVersion}`);
    yield* run("mise", [
      "x", "--yes", `go@${goVersion}`, "--", "go", "build", "-trimpath", "-buildvcs=false", "-ldflags=-s -w", "-o", builtBinary, ".",
    ], {
      cwd: sourceDir,
      env: {
        MISE_DATA_DIR: join(runtimeDir, "mise"),
        MISE_CACHE_DIR: join(runtimeDir, "mise-cache"),
        GOPATH: join(runtimeDir, "go"),
        GOCACHE: join(runtimeDir, "go-build"),
        GOMODCACHE: join(runtimeDir, "go/pkg/mod"),
      },
    });

    yield* run(builtBinary, ["exec", "--help"]);
    yield* fs.writeFileString(markerFile, `${expectedMarker}\n`);
    yield* fs.chmod(markerFile, 0o600);
    yield* fs.makeDirectory(installDir, { recursive: true, mode: 0o700 });
    yield* fs.chmod(installDir, 0o700);
    yield* fs.copyFile(builtBinary, `${binary}.next`);
    yield* fs.chmod(`${binary}.next`, 0o700);
    yield* fs.copyFile(markerFile, `${marker}.next`);
    yield* fs.chmod(`${marker}.next`, 0o600);
    yield* fs.rename(`${binary}.next`, binary);
    yield* fs.rename(`${marker}.next`, marker);
  }));

  yield* verifyInstall();
  yield* Console.log(`ok installed gh-app-auth at ${binary}`);
}).pipe(
  Effect.provide(CommandRunner.layer),
  Effect.provide(NodeServices.layer),
);

runMain(program);
