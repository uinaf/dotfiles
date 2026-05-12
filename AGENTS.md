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
  Only `scripts/configure-codex.sh` may merge the portable Codex defaults; use
  `codex features enable` for feature flags when the CLI is available.
- Do not invent Git identities, signing keys, 1Password vault names, or service
  account tokens. Ask the user or use explicit environment variables.
- Do not store `OP_SERVICE_ACCOUNT_TOKEN` in Git, shell rc files, launchd
  plists, process-compose YAML, or dotenv files. It belongs in machine-local
  secret storage, such as a root-owned token file on a headless devbox, and
  should be fetched by the narrow wrapper that needs it.
- Keep `README.md` and this file short. Move migration detail to
  `docs/migration.md` or a dedicated doc.

## Setup Flow

Use this order when helping a user bootstrap a Mac:

1. Install Xcode Command Line Tools.
2. Install Homebrew.
3. Install `git` and `gh`.
4. Sign in with `gh auth login`.
5. Clone `uinaf/dotfiles` to `~/projects/uinaf/dotfiles`.
6. Run `brew bundle --file ./Brewfile`.
7. Install Oh My Zsh.
8. Run `./scripts/install.sh`.
9. Run `./scripts/configure-git.sh --profile personal` or
   `./scripts/configure-git.sh --profile devbox --non-interactive`.
10. Run `mise install`.
11. Run `./scripts/pull-repos.sh`.
12. Run `./scripts/verify.sh`.

For a devbox, commit signing is expected. Provide at least:

```zsh
GIT_USER_NAME='Devbox' \
GIT_USER_EMAIL='devbox@example.com' \
GIT_SIGNING_KEY='ssh-ed25519 ...' \
OP_SSH_VAULT='Devbox' \
  ./scripts/configure-git.sh --profile devbox --non-interactive
```

If the devbox uses a 1Password service account, install the token into
machine-local secret storage and run 1Password-backed steps through a wrapper
that fetches it at runtime. Do not put the raw token in shell startup, launchd,
process-compose config, or generated runtime dotenv files.

## Verification

Before committing repo changes, run:

```zsh
bash -n scripts/*.sh
shellcheck scripts/*.sh
git diff --check
gitleaks detect --source . --verbose
```

Run `./scripts/verify.sh` only on a machine where the bootstrap is meant to be
active. It checks the live home directory and installed tools.

## Repo Rules

- Use Conventional Commits.
- Keep Git history clean while this repo is still being shaped as a public
  bootstrap source.
- Keep `Brewfile` complete. uinaf machines install the same apps and CLIs by
  default; avoid reintroducing profile-specific Brewfiles.
- Keep Codex setup install-only here. Agent rule links belong to `uinaf/agents`.
- Follow the uinaf repo-doc voice: proper-case headings, sentence-case body,
  short direct prose, no emoji, no SaaS copy.
