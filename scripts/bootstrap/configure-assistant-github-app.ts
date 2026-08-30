#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option, Schema } from "effect";
import { join } from "node:path";
import { CommandRunner, runChecked, runCommand } from "../lib/command.ts";
import { CliFailure, fail, runMain } from "../lib/program.ts";
import { resolveProfile } from "../profiles/current.ts";

const usage = `Usage:
  scripts/bootstrap/configure-assistant-github-app.ts \\
    --name NAME --app-id ID --installation-id ID --repo PATH [--repo PATH ...]
  scripts/bootstrap/configure-assistant-github-app.ts --check \\
    --name NAME --app-id ID --installation-id ID --repo PATH [--repo PATH ...]

Configures one assistant Unix user to use a GitHub App for exact HTTPS
repositories. Each --repo accepts an existing checkout path or an exact
github.com/OWNER/REPO pattern, which is useful before the first private clone.
The private key must already exist at:

  ~/.config/gh/extensions/gh-app-auth/keys/NAME.pem

The command writes an owner-only Git include, configures gh-app-auth with the
exact repository patterns, and verifies Git and API access. It never prints the
private key or a generated token.`;

const AppName = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9._-]+$/)));
const NumericId = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9]+$/)));
const RepositoryPattern = Schema.String.pipe(Schema.check(Schema.isPattern(/^github\.com\/[^/]+\/[^/]+$/)));
const Arguments = Schema.Struct({
  mode: Schema.Literals(["configure", "check"]),
  appName: AppName,
  appId: NumericId,
  installationId: NumericId,
  repos: Schema.NonEmptyArray(Schema.NonEmptyString),
});
type Arguments = typeof Arguments.Type;

const parseArguments = Effect.fn("parseAssistantGithubAppArguments")(function*(args: readonly string[]) {
  const parsed: {
    mode: "configure" | "check";
    appName?: string;
    appId?: string;
    installationId?: string;
    repos: string[];
  } = { mode: "configure", repos: [] };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--check") {
      parsed.mode = "check";
      continue;
    }
    const field = argument === "--name"
      ? "appName"
      : argument === "--app-id"
        ? "appId"
        : argument === "--installation-id"
          ? "installationId"
          : undefined;
    if (field !== undefined) {
      const value = args[index + 1];
      if (!value || parsed[field] !== undefined) return yield* fail(`invalid ${argument}`, 2);
      parsed[field] = value;
      index += 1;
      continue;
    }
    if (argument === "--repo") {
      const value = args[index + 1];
      if (!value) return yield* fail("invalid --repo", 2);
      parsed.repos.push(value);
      index += 1;
      continue;
    }
    return yield* fail(`unsupported argument ${argument}`, 2);
  }
  return yield* Schema.decodeUnknownEffect(Arguments, { errors: "all", onExcessProperty: "error" })(parsed).pipe(
    Effect.mapError((error) => new CliFailure({ exitCode: 1, message: `invalid GitHub App arguments: ${error.message}` })),
  );
});

const runRaw = runCommand;
const run = runChecked;

const validateOwnerOnly = Effect.fn("validateOwnerOnly")(function*(
  label: string,
  path: string,
  expectedType: "File" | "Directory",
  exactMode?: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const link = yield* fs.readLink(path).pipe(Effect.option);
  const info = yield* fs.stat(path).pipe(
    Effect.mapError(() => new CliFailure({ exitCode: 1, message: `${label} must be a ${expectedType.toLowerCase()}: ${path}` })),
  );
  if (Option.isSome(link) || info.type !== expectedType) {
    return yield* fail(`${label} must be a ${expectedType.toLowerCase()}: ${path}`);
  }
  if (Option.getOrUndefined(info.uid) !== process.getuid?.()) {
    return yield* fail(`${label} is not owned by the current user: ${path}`);
  }
  if (exactMode !== undefined ? (info.mode & 0o777) !== exactMode : (info.mode & 0o077) !== 0) {
    return yield* fail(`${label} permissions must be owner-only: ${path} (mode ${(info.mode & 0o777).toString(8)})`);
  }
});

const parsePattern = Effect.fn("parseGithubRepositoryPattern")(function*(input: string, label: string) {
  return yield* Schema.decodeUnknownEffect(RepositoryPattern)(input).pipe(
    Effect.mapError(() => new CliFailure({ exitCode: 1, message: `${label} must use github.com/OWNER/REPO: ${input}` })),
  );
});

const resolveRepository = Effect.fn("resolveAssistantGithubRepository")(function*(input: string) {
  if (input.startsWith("github.com/")) {
    return { pattern: yield* parsePattern(input, "repository pattern"), checkout: undefined };
  }
  const fs = yield* FileSystem.FileSystem;
  const checkout = yield* fs.realPath(input).pipe(
    Effect.mapError(() => new CliFailure({ exitCode: 1, message: `could not resolve repository checkout: ${input}` })),
  );
  const inside = yield* runRaw("git", ["-C", checkout, "rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0) return yield* fail(`repository path is not a Git checkout: ${checkout}`);
  const originResult = yield* runRaw("git", ["-C", checkout, "remote", "get-url", "origin"]);
  if (originResult.status !== 0) return yield* fail(`repository has no origin remote: ${checkout}`);
  const origin = originResult.stdout.trim();
  if (!origin.startsWith("https://github.com/")) {
    return yield* fail(`assistant GitHub App repositories must use an HTTPS github.com origin: ${checkout}`);
  }
  const repository = origin.slice("https://github.com/".length).replace(/\.git$/, "");
  const pattern = yield* parsePattern(`github.com/${repository}`, "origin");
  return { pattern, checkout };
});

function shellQuote(path: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;
}

const program = Effect.gen(function*() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 1 && (rawArgs[0] === "-h" || rawArgs[0] === "--help")) {
    yield* Console.log(usage);
    return;
  }
  const args: Arguments = yield* parseArguments(rawArgs).pipe(Effect.tapError(() => Console.error(usage)));
  const profile = yield* resolveProfile(undefined).pipe(
    Effect.mapError(() => new CliFailure({ exitCode: 1, message: "a persisted dotfiles profile is required" })),
  );
  if (profile !== "assistant") {
    return yield* fail("GitHub App global authentication is supported only for the assistant profile");
  }

  const fs = yield* FileSystem.FileSystem;
  const home = process.env.HOME || "";
  const appAuthBinary = join(home, ".local/share/gh/extensions/gh-app-auth/gh-app-auth");
  const binaryInfo = yield* fs.stat(appAuthBinary).pipe(Effect.option);
  if (Option.isNone(binaryInfo) || binaryInfo.value.type !== "File" || (binaryInfo.value.mode & 0o111) === 0) {
    return yield* fail("missing gh-app-auth; rerun the assistant profile installer");
  }
  const keyDir = join(home, ".config/gh/extensions/gh-app-auth/keys");
  const keyFile = join(keyDir, `${args.appName}.pem`);
  yield* validateOwnerOnly("GitHub App key directory", keyDir, "Directory", 0o700);
  yield* validateOwnerOnly("GitHub App private key", keyFile, "File");

  const repositories = yield* Effect.forEach(args.repos, resolveRepository);
  const patterns = repositories.map(({ pattern }) => pattern);
  if (new Set(patterns).size !== patterns.length) {
    const duplicate = patterns.find((pattern, index) => patterns.indexOf(pattern) !== index);
    return yield* fail(`duplicate repository pattern: ${duplicate}`);
  }
  const patternsCsv = patterns.join(",");
  const configDir = join(home, ".config/dotfiles");
  const gitInclude = join(configDir, "github-app.gitconfig");
  yield* validateOwnerOnly("dotfiles config directory", configDir, "Directory", 0o700);

  const includes = yield* runRaw("git", ["config", "--global", "--get-all", "include.path"]);
  const requiredInclude = "~/.config/dotfiles/github-app.gitconfig";
  if (!includes.stdout.split("\n").includes(requiredInclude)) {
    return yield* fail("assistant Git base does not include ~/.config/dotfiles/github-app.gitconfig; reapply the assistant profile");
  }

  yield* Effect.scoped(Effect.gen(function*() {
    const temporaryInclude = yield* fs.makeTempFileScoped({ directory: configDir, prefix: ".github-app.gitconfig." });
    const helper = `!${shellQuote(appAuthBinary)} git-credential`;
    yield* run("git", ["config", "--file", temporaryInclude, "--add", "credential.https://github.com.helper", ""]);
    yield* run("git", ["config", "--file", temporaryInclude, "--add", "credential.https://github.com.helper", helper]);
    yield* run("git", ["config", "--file", temporaryInclude, "credential.https://github.com.useHttpPath", "true"]);
    yield* fs.chmod(temporaryInclude, 0o600);

    if (args.mode === "configure") {
      yield* run("gh", [
        "app-auth", "setup",
        "--app-id", args.appId,
        "--installation-id", args.installationId,
        "--key-file", keyFile,
        "--patterns", patternsCsv,
        "--name", args.appName,
        "--use-filesystem",
      ]);
      const existingLink = yield* fs.readLink(gitInclude).pipe(Effect.option);
      const existing = yield* fs.exists(gitInclude);
      if (existing || Option.isSome(existingLink)) {
        yield* validateOwnerOnly("assistant GitHub App include", gitInclude, "File");
      }
      yield* fs.rename(temporaryInclude, gitInclude);
    } else {
      yield* validateOwnerOnly("assistant GitHub App include", gitInclude, "File");
      const [expected, actual] = yield* Effect.all([
        fs.readFileString(temporaryInclude),
        fs.readFileString(gitInclude),
      ]);
      if (expected !== actual) {
        return yield* fail("assistant GitHub App include does not match the expected helper contract; rerun without --check");
      }
    }
  }));

  const humanAuth = yield* runRaw("gh", ["auth", "status", "--hostname", "github.com"]);
  if (humanAuth.status === 0) {
    return yield* fail("a human gh auth login exists; remove it before using the assistant GitHub App identity");
  }
  const appList = yield* run("gh", ["app-auth", "list"]);
  const matchingRow = appList.stdout.split("\n").map((line) => line.split("\t")).find(
    (fields) => fields[0] === args.appName && fields[1] === args.appId && fields[2] === args.installationId,
  );
  if (!matchingRow) return yield* fail("gh-app-auth does not contain the expected App and installation");
  if ((matchingRow[3] || "").replaceAll(" ", "") !== patternsCsv) {
    return yield* fail("gh-app-auth repository patterns differ from the requested exact set");
  }

  for (const [index, pattern] of patterns.entries()) {
    const expectedRepo = pattern.slice("github.com/".length);
    const authTest = yield* runRaw("gh", ["app-auth", "test", "--repo", pattern]);
    if (authTest.status !== 0) return yield* fail(`GitHub App authentication failed for ${pattern}`);
    const api = yield* runRaw("gh", [
      "app-auth", "exec", "--repo", pattern, "--", "gh", "api", `repos/${expectedRepo}`, "--jq", ".full_name",
    ]);
    if (api.status !== 0) return yield* fail(`GitHub API access failed for ${pattern}`);
    if (api.stdout.trim() !== expectedRepo) return yield* fail(`GitHub API returned the wrong repository for ${pattern}`);
    const checkout = repositories[index]?.checkout;
    if (checkout !== undefined) {
      const gitAccess = yield* runRaw("git", ["-C", checkout, "ls-remote", "origin", "HEAD"], {
        env: { GIT_TERMINAL_PROMPT: "0" },
      });
      if (gitAccess.status !== 0) return yield* fail(`Git authentication failed for ${pattern}`);
    }
  }
  yield* Console.log(`ok assistant GitHub App ${args.appName} is configured for ${patterns.length} exact repositories`);
}).pipe(
  Effect.provide(CommandRunner.layer),
  Effect.provide(NodeServices.layer),
);

runMain(program);
