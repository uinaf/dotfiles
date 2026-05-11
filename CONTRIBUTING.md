# Contributing

## Scope

This repo is a public Mac bootstrap layer for uinaf machines.

Keep changes portable. Machine identity, secrets, tokens, keys, certificates,
Codex state, browser profiles, app caches, and project checkouts stay local.

## Local Setup

```zsh
brew install git gh shellcheck gitleaks
gh auth login

gh repo clone uinaf/dotfiles ~/projects/uinaf/dotfiles
cd ~/projects/uinaf/dotfiles
```

## Daily Workflow

Before opening a pull request, run:

```zsh
bash -n scripts/*.sh
shellcheck scripts/*.sh
git diff --check
gitleaks detect --source . --verbose
```

Run `./scripts/verify.sh` only on a machine where these dotfiles are actively
installed. It checks the live home directory.

## Brewfiles

- `Brewfile` is the complete app and CLI set for uinaf Macs.
- `Brewfile.personal` and `Brewfile.devbox` are deprecated compatibility files.

Do not split tools into profile Brewfiles unless there is a concrete machine
conflict.

## Pull Requests

Use Conventional Commits.

Keep pull requests focused. Include the commands you ran and any skipped checks.
