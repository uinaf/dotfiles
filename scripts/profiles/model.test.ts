import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseProfileModel, readProfileModel, requireProfile } from "./model.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const modelPath = join(repoRoot, "chezmoi/.chezmoidata/profiles.json");
const sourceDir = join(repoRoot, "chezmoi");
const profileNames = [
  "assistant",
  "devbox",
  "personal-devbox",
  "personal-workstation",
  "workstation",
];

function rawModel(): { profileModel: Record<string, unknown> & { profiles: Record<string, Record<string, unknown>> } } {
  return JSON.parse(readFileSync(modelPath, "utf8"));
}

function renderProfile(profile: string, profileModel?: unknown): ReturnType<typeof spawnSync> {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-profile-render-"));
  mkdirSync(join(root, "home"));
  mkdirSync(join(root, "tmp"));
  const override = profileModel === undefined ? { dotfilesProfile: profile } : { dotfilesProfile: profile, profileModel };
  const result = spawnSync("chezmoi", [
    "--source",
    sourceDir,
    "--override-data",
    JSON.stringify(override),
    "execute-template",
    '{{ includeTemplate "profile" . }}',
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "xdg/config"),
      XDG_CACHE_HOME: join(root, "xdg/cache"),
      TMPDIR: join(root, "tmp"),
      NO_COLOR: "1",
    },
  });
  rmSync(root, { recursive: true, force: true });
  return result;
}

test("canonical model covers every profile and renders through chezmoi", () => {
  const model = readProfileModel(modelPath);
  assert.deepEqual(Object.keys(model.profiles).sort(), profileNames);
  for (const profile of profileNames) {
    const result = renderProfile(profile);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), model.profiles[profile]);
  }
});

test("TypeScript rejects malformed, unsupported, missing, and wrong-type data", () => {
  assert.throws(() => parseProfileModel('{"profileModel":'), /not valid JSON/);

  const unsupported = rawModel();
  unsupported.profileModel.version = 2;
  assert.throws(() => parseProfileModel(JSON.stringify(unsupported)), /version 1/);

  const missing = rawModel();
  const capabilities = missing.profileModel.profiles.workstation.capabilities as Record<string, unknown>;
  delete capabilities.developer;
  assert.throws(() => parseProfileModel(JSON.stringify(missing)), /capabilities have an invalid shape/);

  const wrongType = rawModel();
  (wrongType.profileModel.profiles.workstation.capabilities as Record<string, unknown>).developer = "yes";
  assert.throws(() => parseProfileModel(JSON.stringify(wrongType)), /must be boolean/);

  const missingRuntimeStep = rawModel();
  missingRuntimeStep.profileModel.profiles.assistant.installSteps = ["apply-dotfiles", "install-gh-app-auth"];
  assert.throws(() => parseProfileModel(JSON.stringify(missingRuntimeStep)), /runtime group and install steps disagree/);

  const model = readProfileModel(modelPath);
  assert.throws(() => requireProfile(model, "unknown"), /unknown profile/);
  assert.throws(() => requireProfile(model, "constructor"), /unknown profile/);
});

test("Brewfile gates GUI casks on the workstation capability", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-profile-brewfile-"));
  const fixtureModelPath = join(root, "chezmoi/.chezmoidata/profiles.json");
  const listCasks = (profile: string): string[] => {
    const result = spawnSync("brew", ["bundle", "list", "--cask", "--file", join(root, "Brewfile.personal")], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOMEBREW_BUNDLE_DOTFILES_PROFILE: profile,
        HOMEBREW_NO_AUTO_UPDATE: "1",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split("\n").filter(Boolean);
  };

  try {
    mkdirSync(dirname(fixtureModelPath), { recursive: true });
    writeFileSync(join(root, "Brewfile.personal"), readFileSync(join(repoRoot, "Brewfile.personal")));
    const model = rawModel();
    const personalDevbox = model.profileModel.profiles["personal-devbox"]?.capabilities as Record<string, unknown>;
    personalDevbox.workstation = false;
    writeFileSync(fixtureModelPath, JSON.stringify(model));
    assert.deepEqual(listCasks("personal-devbox"), []);

    const personalWorkstation = model.profileModel.profiles["personal-workstation"]?.capabilities as Record<string, unknown>;
    personalWorkstation.workstation = true;
    writeFileSync(fixtureModelPath, JSON.stringify(model));
    const workstationCasks = listCasks("personal-workstation");
    assert.equal(workstationCasks.includes("slopwake"), true);
    assert.equal(workstationCasks.includes("cleanshot"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shell queries typed values and rejects invalid boundaries", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-profile-shell-"));
  const fixturePath = join(root, "chezmoi/.chezmoidata/profiles.json");
  const profileLibrary = join(root, "scripts/lib/profile.sh");
  const run = (command: string) => spawnSync("bash", ["-c", `. "$1"; ${command}`, "profile-model", profileLibrary], {
    encoding: "utf8",
    env: process.env,
  });
  try {
    mkdirSync(dirname(fixturePath), { recursive: true });
    mkdirSync(dirname(profileLibrary), { recursive: true });
    writeFileSync(profileLibrary, readFileSync(join(repoRoot, "scripts/lib/profile.sh")));
    writeFileSync(fixturePath, readFileSync(modelPath));
    let result = run("dotfiles_profile_brewfiles personal-devbox");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "Brewfile\nBrewfile.developer\nBrewfile.devbox\nBrewfile.personal\n");
    assert.equal(run("dotfiles_normalize_profile workstation.capabilities").status, 2);

    const unsupported = rawModel();
    unsupported.profileModel.version = 2;
    writeFileSync(fixturePath, JSON.stringify(unsupported));
    assert.equal(run("dotfiles_normalize_profile workstation").status, 2);

    const wrongType = rawModel();
    (wrongType.profileModel.profiles.workstation.capabilities as Record<string, unknown>).developer = "yes";
    writeFileSync(fixturePath, JSON.stringify(wrongType));
    assert.equal(run("dotfiles_profile_is_developer workstation").status, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("chezmoi rejects unsupported, unknown, missing, and wrong-type data", () => {
  const unsupported = rawModel();
  unsupported.profileModel.version = 2;
  assert.notEqual(renderProfile("workstation", unsupported.profileModel).status, 0);
  assert.notEqual(renderProfile("unknown").status, 0);

  const missing = rawModel();
  delete (missing.profileModel.profiles.workstation.capabilities as Record<string, unknown>).developer;
  assert.notEqual(renderProfile("workstation", missing.profileModel).status, 0);

  const wrongType = rawModel();
  (wrongType.profileModel.profiles.workstation.capabilities as Record<string, unknown>).developer = "yes";
  assert.notEqual(renderProfile("workstation", wrongType.profileModel).status, 0);

  const missingRuntimeStep = rawModel();
  missingRuntimeStep.profileModel.profiles.assistant.installSteps = ["apply-dotfiles", "install-gh-app-auth"];
  assert.notEqual(renderProfile("assistant", missingRuntimeStep.profileModel).status, 0);
});

test("chezmoi rejects malformed profile data before rendering", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-profile-syntax-"));
  try {
    mkdirSync(join(root, ".chezmoidata"), { recursive: true });
    mkdirSync(join(root, ".chezmoitemplates"), { recursive: true });
    mkdirSync(join(root, "home"));
    mkdirSync(join(root, "tmp"));
    writeFileSync(join(root, ".chezmoidata/profiles.json"), '{"profileModel":');
    writeFileSync(join(root, ".chezmoitemplates/profile"), readFileSync(join(sourceDir, ".chezmoitemplates/profile")));
    const result = spawnSync("chezmoi", [
      "--source",
      root,
      "--override-data",
      '{"dotfilesProfile":"workstation"}',
      "execute-template",
      '{{ includeTemplate "profile" . }}',
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: join(root, "home"),
        XDG_CONFIG_HOME: join(root, "xdg/config"),
        XDG_CACHE_HOME: join(root, "xdg/cache"),
        TMPDIR: join(root, "tmp"),
        NO_COLOR: "1",
      },
    });
    assert.notEqual(result.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
