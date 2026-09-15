import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "vite-plus/test";

const source = resolve(import.meta.dirname, "..");

for (const maintenance of [false, true]) {
  test(`unknown steps fail before any ${maintenance ? "maintenance" : "setup"} command`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "dotfiles-invalid-steps-"));
    t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const model = JSON.parse(
      readFileSync(join(source, "chezmoi/.chezmoidata/profiles.json"), "utf8"),
    );
    model.profileModel.profiles.developer.installSteps = [
      "apply-dotfiles",
      "install-runtimes",
      "install-repository-dependencies",
      "not-a-real-step",
    ];
    mkdirSync(join(root, "chezmoi/.chezmoidata"), { recursive: true });
    writeFileSync(join(root, "chezmoi/.chezmoidata/profiles.json"), JSON.stringify(model));
    for (const file of ["bootstrap/apply-dotfiles.ts", "homebrew/brew-bundle.ts", "bin/mise"]) {
      const path = join(root, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '#!/bin/sh\nprintf invoked >> "$TEST_LOG"\n', { mode: 0o700 });
    }
    const log = join(root, "commands");
    const result = spawnSync(
      process.execPath,
      [
        join(source, "bootstrap/install.ts"),
        "--profile",
        "developer",
        ...(maintenance ? ["--maintenance"] : []),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          DOTFILES_INSTALL_REPO_ROOT: root,
          MISE_DATA_DIR: join(root, "mise"),
          PATH: `${join(root, "bin")}:${process.env.PATH}`,
          TEST_LOG: log,
        },
      },
    );
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /\["installSteps"\]\[3\]/);
    assert.equal(existsSync(log), false, "validation must precede every mutating command");
  });
}
