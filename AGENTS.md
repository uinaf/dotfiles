# AGENTS.md

Guidance for agents helping with this repo.

## Role

This is a public Mac bootstrap repo for uinaf machines.

Help the user install tools, link dotfiles, configure local Git identity, and
verify the machine. Keep the repo public-safe. Keep machine state local.

## Boundaries

- Do not commit secrets, tokens, private keys, certificates, Tizen archives, or
  machine-local config.
- Do not back up, copy, link, or summarize the full `~/.codex/config.toml`,
  Browser approvals, Codex auth, sessions, caches, worktrees, or app state.
  Only `scripts/bootstrap/configure-codex.sh` may merge the portable Codex defaults; use
  `codex features enable` for feature flags when the CLI is available.
- Do not invent Git identities, signing keys, 1Password vault names, or service
  account tokens. Ask the user or use explicit environment variables.
- Do not store `OP_SERVICE_ACCOUNT_TOKEN` in Git, shell rc files, launchd
  plists, process-compose YAML, or dotenv files. It belongs in machine-local
  secret storage, such as a root-owned token file on a headless devbox, and
  should be fetched by the narrow wrapper that needs it.
- Keep `README.md` and this file short. Move detailed operational guidance to
  dedicated docs.

## Setup Flow

Use this order when helping a user bootstrap a Mac:

1. Install Xcode Command Line Tools.
2. Install Homebrew.
3. Install `git` and `gh`.
4. Sign in with `gh auth login`.
5. Clone `uinaf/dotfiles` to `~/projects/uinaf/dotfiles`.
6. Run `./scripts/bootstrap/brew-bundle.sh personal` or `./scripts/bootstrap/brew-bundle.sh devbox`.
7. Install Oh My Zsh.
8. Run `./scripts/bootstrap/install.sh`.
9. Run `./scripts/bootstrap/configure-git.sh --profile personal` or
   `./scripts/bootstrap/configure-git.sh --profile devbox --non-interactive`.
10. Run `mise install`.
11. Run `./scripts/bootstrap/pull-repos.sh`.
12. Run `./scripts/bootstrap/verify.sh --profile personal` or
    `./scripts/bootstrap/verify.sh --profile devbox`.

For a devbox, commit signing is expected. Provide at least:

```zsh
GIT_USER_NAME='Devbox' \
GIT_USER_EMAIL='devbox@example.com' \
GIT_SIGNING_KEY='ssh-ed25519 ...' \
OP_SSH_VAULT='Devbox' \
  ./scripts/bootstrap/configure-git.sh --profile devbox --non-interactive
```

If the devbox uses a 1Password service account, install the token into
machine-local secret storage and run 1Password-backed steps through a wrapper
that fetches it at runtime. Do not put the raw token in shell startup, launchd,
process-compose config, or generated runtime dotenv files.

## Verification

Before committing repo changes, run:

```zsh
find scripts -name '*.sh' -print0 | xargs -0 bash -n
find scripts -name '*.sh' -print0 | xargs -0 shellcheck
git diff --check
gitleaks detect --source . --verbose
./scripts/security/audit.sh --skip-mscp
```

Follow [Security audits](docs/security-audits.md) when changing audit scripts,
secret scanning, mSCP integration, or devbox security checks.

Run `./scripts/bootstrap/verify.sh --profile personal` or
`./scripts/bootstrap/verify.sh --profile devbox` only on a machine where the
bootstrap is meant to be active. It checks the live home directory and
installed tools.

## Repo Rules

- Use Conventional Commits.
- Keep Git history clean while this repo is still being shaped as a public
  bootstrap source.
- Keep `Brewfile` shared and profile-neutral. Put laptop-only apps in
  `Brewfile.personal` and shared Mac mini/devbox tools in `Brewfile.devbox`.
- Keep Codex setup install-only here. Agent rule links belong to `uinaf/agents`.
- Follow the uinaf repo-doc voice: proper-case headings, sentence-case body,
  short direct prose, no emoji, no SaaS copy.
