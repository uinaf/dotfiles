# Contributing

## Setup

This is a public macOS bootstrap framework. Keep changes portable and keep
machine identity, credentials, app state, and project checkouts local.

Install the prerequisites and clone the repository:

```zsh
brew install git gh
gh auth login
gh repo clone uinaf/dotfiles ~/projects/dotfiles
cd ~/projects/dotfiles
./scripts/bootstrap/brew-bundle.sh workstation
./scripts/bootstrap/apply-dotfiles.sh --profile workstation
mise trust
mise install
./scripts/bootstrap/install.sh --profile workstation
```

Use the [Bootstrap guide](docs/bootstrap.md) for a different profile or a Mac
that does not yet have Homebrew, Git, or GitHub CLI.

## Verify

List the domains and run the focused check that owns the change:

```zsh
./scripts/verify/repo.sh --list
./scripts/verify/repo.sh --domain config
```

`./scripts/verify/repo.sh --skip-security` runs every deterministic check in
parallel. The same complete graph runs in CI. Run `./scripts/verify/repo.sh`
when the local full-history secret scan is useful.

Live bootstrap checks inspect the active home directory. Run them only when
the current machine should satisfy that profile.

## Change the Owning Surface

- Packages: `Brewfile`, `Brewfile.developer`, and `Brewfile.<profile>`.
- Dotfiles: tracked source under `chezmoi/`.
- Repo tasks: `.mise/tasks/`; machine runtime pins:
  `chezmoi/private_dot_config/mise/config.toml.tmpl`.
- Global agent setup: `scripts/agents/`; repository-local skills remain with
  their consumer.
- Setup behavior: `scripts/bootstrap/`; verification and audit behavior:
  `scripts/verify/` and `scripts/audit/`.

Read the matching guide from the [documentation map](README.md#documentation)
before changing a contract. Keep one-machine preferences local or in a fork.

## Pull Requests

Use Conventional Commits; commit types drive the tag-only release policy in
[GitHub pipelines](docs/github-pipelines.md). Keep pull requests focused,
include verification performed, and update the owning guide when a command,
path, profile, or security boundary changes.
