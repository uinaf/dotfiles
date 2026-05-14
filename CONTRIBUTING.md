# Contributing

## Scope

This repo is a public Mac bootstrap layer for uinaf machines.

Keep changes portable. Machine identity, secrets, tokens, keys, certificates,
Codex state, browser profiles, app caches, and project checkouts stay local.

## Local Setup

```zsh
brew install git gh
gh auth login

gh repo clone uinaf/dotfiles ~/projects/uinaf/dotfiles
cd ~/projects/uinaf/dotfiles
./scripts/bootstrap/brew-bundle.sh --shared-only
```

For full machine bootstrap, or for a fresh Mac that does not have `git` or
`gh` yet, use [Bootstrap guide](docs/bootstrap.md).

## Daily Workflow

Before opening a pull request, run:

```zsh
./scripts/verify/repo.sh
```

Run `./scripts/verify/bootstrap.sh` only on a machine where these dotfiles are
actively installed. It checks the live home directory.

Use `./scripts/verify/repo.sh --skip-security` for a fast local loop,
but run the full command before committing or pushing.

## Brewfiles

- `Brewfile` is the shared app and CLI set for every uinaf Mac.
- `Brewfile.personal` contains shared personal Mac apps and local development
  extras, not one-user preferences.
- `Brewfile.devbox` contains shared Mac mini/devbox tools.

Keep one-machine personalization local. Use a fork for durable personal
preferences, and send a focused pull request when a preference should become
shared repo policy.

## Pull Requests

Use Conventional Commits.

Keep pull requests focused. Include the commands you ran and any skipped checks.
If a change affects setup behavior, update [Bootstrap guide](docs/bootstrap.md),
[Agent guide](AGENTS.md), or [Agent readiness](docs/agent-readiness.md) in the
same change.
