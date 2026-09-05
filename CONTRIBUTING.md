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
brew install mise
./dotfiles prepare
export PATH="$(mise --no-config where node@24.19.0)/bin:$PATH"
brew install actionlint chezmoi shellcheck
mise trust
mise run verify:domain static
```

For a new agent worktree on a prepared Mac, run `./dotfiles prepare`, then
`mise trust` and the focused verification domain. This installs repository
dependencies without applying dotfiles or changing the machine profile.

Use the [Bootstrap guide](docs/bootstrap.md) for a different profile or a Mac
that does not yet have Homebrew, Git, or GitHub CLI.

## Verify

List the domains and run the focused check that owns the change:

```zsh
mise run verify:domain config # example; select the owning domain
mise run verify:fast
mise run verify
```

- `verify:fast` runs every deterministic check in parallel; CI runs the same
  graph on pull requests and manual dispatch.
- `verify` also runs the local full-history secret scan. Run it before direct
  pushes; push workflows only evaluate releases and do not verify the tree.
- Live bootstrap checks inspect the active home directory. Run them only when the
  current machine should satisfy that profile.

Optionally install the commit-hygiene pre-push hook:

```zsh
./scripts/verify/install-pre-push-hook.ts
```

It checks only outgoing commit objects for whitespace and conflict-marker
errors. It does not replace verification; pull requests use CI, while direct
pushes require the full local gate.

## Change the Owning Surface

- Packages: `Brewfile`, `Brewfile.developer`, and `Brewfile.<profile>`.
- Dotfiles: tracked source under `chezmoi/`.
- Repo tasks: `mise.toml`; machine runtime pins:
  `chezmoi/private_dot_config/mise/config.toml.tmpl`.
- Global agent setup: `scripts/agents/`; repository-local skills remain with
  their consumer.
- Setup behavior: `scripts/bootstrap/`; verification and audit behavior:
  `scripts/verify/` and `scripts/audit/`.

Read the matching guide from the [documentation map](README.md#documentation)
before changing a contract. Keep one-machine preferences local, in
`~/.config/dotfiles/zshenv.local`, or in a fork.

## Pull Requests

- Use Conventional Commits. Commit types drive the tag-only release policy in
  [GitHub pipelines](docs/github-pipelines.md).
- Keep pull requests focused and include the verification performed.
- Update the owning guide when a command, path, profile, or security boundary
  changes.
