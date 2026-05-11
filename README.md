# dotfiles

Mac bootstrap files and scripts for uinaf machines.

This repo manages the portable layer: Homebrew apps, zsh startup, mise
runtimes, Git defaults, SSH defaults, Zed, Ghostty, and setup scripts.

It does not manage secrets, Codex state, browser profiles, app caches,
dependency folders, build output, or machine-specific project checkouts.

## Quick Start

```zsh
xcode-select --install
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

brew install git gh
gh auth login

mkdir -p ~/projects/uinaf
gh repo clone uinaf/dotfiles ~/projects/uinaf/dotfiles
cd ~/projects/uinaf/dotfiles

brew bundle --file ./Brewfile
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"

./scripts/install.sh
./scripts/configure-git.sh --profile personal
mise install
./scripts/pull-repos.sh
./scripts/verify.sh
```

For a devbox:

```zsh
GIT_USER_NAME='Devbox' \
GIT_USER_EMAIL='devbox@example.com' \
GIT_SIGNING_KEY='ssh-ed25519 ...' \
OP_SSH_VAULT='Devbox' \
  ./scripts/configure-git.sh --profile devbox --non-interactive
```

If the devbox uses a 1Password service account, provide
`OP_SERVICE_ACCOUNT_TOKEN` through the machine's secret manager or launch
environment. This repo does not store it.

## Managed Files

| Path | Purpose |
| --- | --- |
| `Brewfile` | Homebrew apps and CLIs for every uinaf Mac. |
| `Brewfile.personal` | Deprecated compatibility file. |
| `Brewfile.devbox` | Deprecated compatibility file. |
| `home/.zshenv` | Minimal zsh environment. |
| `home/.zprofile` | Login-shell Homebrew and mise bootstrap. |
| `home/.zshrc` | Interactive zsh, Oh My Zsh, mise, direnv, and PATH. |
| `home/.config/mise/config.toml` | Global runtime defaults. |
| `home/.gitconfig` | Shared Git defaults. Includes `~/.gitconfig.local`. |
| `home/.ssh/config` | Shared SSH defaults. Includes `~/.ssh/config.local`. |
| `home/.config/zed/*` | Zed settings and keymap. |
| `home/Library/Application Support/com.mitchellh.ghostty/config` | Ghostty settings. |

## Local State

These stay outside the repo:

- Git identity, signing key, and commit-signing preference.
- 1Password SSH agent vault selection.
- 1Password service-account tokens.
- Codex config, Browser approvals, auth, sessions, caches, worktrees, and app
  state.
- SSH private keys.
- Browser profiles.
- Docker and Colima state.
- `node_modules`, language-server caches, and build output.

`./scripts/configure-git.sh` writes `~/.gitconfig.local`. Set `OP_SSH_VAULT` if
the machine should also get a local 1Password SSH agent config.

`~/.codex/AGENTS.md` is owned by `uinaf/agents`, not this repo.
`./scripts/pull-repos.sh` clones or updates `uinaf/agents` and runs its sync
script.

## Agent Help

Agents helping with setup should read [Agent guide](AGENTS.md). It contains the
bootstrap order, local-state boundaries, devbox signing expectations, and
verification commands.

## Scripts

| Script | Purpose |
| --- | --- |
| `scripts/install.sh` | Link tracked files from `home/` into `~`. |
| `scripts/configure-git.sh` | Write local Git identity and optional 1Password SSH config. |
| `scripts/pull-repos.sh` | Clone or fast-forward shared bootstrap repos. |
| `scripts/verify.sh` | Check the current machine bootstrap. |
| `scripts/tizen-install.sh` | Install Samsung Tizen Studio from the CLI installer. |
| `scripts/tizen-pack.sh` | Archive Tizen cert/profile state. |
| `scripts/tizen-restore.sh` | Restore a Tizen cert/profile archive. |
| `scripts/tizen-restore-from-1password.sh` | Restore a Tizen archive from 1Password. |

## Notes

- Install Berkeley Mono separately for the intended Ghostty and Zed font setup.
- Java is mise-managed through Temurin. Do not install a global Homebrew
  OpenJDK for this setup.
- Ruby is not global. Repos that need Ruby should declare it repo-locally.
- Tizen certificates, profiles, and device keys do not belong in Git.
- `scripts/tizen-install.sh` verifies `tizen`, `sdb`, and
  `package-manager-cli show-info`. It skips package catalog listing by default;
  use `--show-pkgs` only when needed because Samsung's extension catalog
  download can hang.

## Contributing

See [Contributing](CONTRIBUTING.md).

## Security

Report vulnerabilities privately. See [Security](SECURITY.md).

## License

MIT. See [License](LICENSE).

Old-machine migration notes live in [Migration checklist](docs/migration.md).
