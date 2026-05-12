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
./scripts/bootstrap/verify-repo.sh
```

Run `./scripts/bootstrap/verify.sh` only on a machine where these dotfiles are
actively installed. It checks the live home directory.

## Brewfiles

- `Brewfile` is the shared app and CLI set for every uinaf Mac.
- `Brewfile.personal` contains personal Mac apps and local development extras.
- `Brewfile.devbox` contains shared Mac mini/devbox tools.

## Pull Requests

Use Conventional Commits.

Keep pull requests focused. Include the commands you ran and any skipped checks.
