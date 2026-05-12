# dotfiles

Mac bootstrap files and scripts for uinaf machines.

This repo manages the portable layer: Homebrew apps, zsh startup, mise
runtimes, Git defaults, SSH defaults, Codex defaults, Zed, Ghostty, and setup
scripts.

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

./scripts/brew-bundle.sh personal
./scripts/install-blacksmith.sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"

./scripts/install.sh
./scripts/configure-git.sh --profile personal
mise install
./scripts/pull-repos.sh
./scripts/verify.sh --profile personal
```

For a devbox:

```zsh
./scripts/brew-bundle.sh devbox

GIT_USER_NAME='Devbox' \
GIT_USER_EMAIL='devbox@example.com' \
GIT_SIGNING_KEY='ssh-ed25519 ...' \
OP_SSH_VAULT='Devbox' \
  ./scripts/configure-git.sh --profile devbox --non-interactive
```

If the devbox uses a 1Password service account, provide
`OP_SERVICE_ACCOUNT_TOKEN` through machine-local secret storage and a narrow
runtime wrapper. Do not put the raw token in shell startup, launchd plists,
process-compose YAML, or dotenv files. This repo does not store it.

## Managed Files

| Path | Purpose |
| --- | --- |
| `Brewfile` | Shared Homebrew CLIs for every uinaf Mac. |
| `Brewfile.personal` | Personal Mac apps, GUI tools, and local development extras. |
| `Brewfile.devbox` | Devbox apps and CLIs for shared Mac mini agent hosts. |
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
- Codex auth, Browser approvals, sessions, caches, worktrees, and app state.
- SSH private keys.
- Browser profiles.
- Docker and Colima state.
- `node_modules`, language-server caches, and build output.

See [Devbox setup](docs/devbox.md) for the process-compose and 1Password
pattern used by always-on agent hosts.

`./scripts/configure-git.sh` writes `~/.gitconfig.local`. Set `OP_SSH_VAULT` if
the machine should also get a local 1Password SSH agent config.

`./scripts/install.sh` merges the default Codex model and reasoning effort, then
uses `codex features enable` for portable feature defaults, without linking or
owning the full Codex state file.
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
| `scripts/brew-bundle.sh` | Install the shared Brewfile plus a selected profile Brewfile. |
| `scripts/install.sh` | Link tracked files from `home/` into `~`. |
| `scripts/configure-codex.sh` | Merge portable Codex defaults into local config. |
| `scripts/configure-git.sh` | Write local Git identity and optional 1Password SSH config. |
| `scripts/devbox-refresh-openclaw-env.sh` | Refresh a generated OpenClaw env from one 1Password item. |
| `scripts/install-devbox-op-token.sh` | Install a devbox 1Password service-account token from stdin into root-owned local storage. |
| `scripts/install-devbox-env-refresh.sh` | Install the root-owned devbox env refresh helper and LaunchDaemon. |
| `scripts/install-blacksmith.sh` | Install the Blacksmith CLI from its official checksum-verifying installer. |
| `scripts/pull-repos.sh` | Clone or fast-forward shared bootstrap repos. |
| `scripts/security-audit.sh` | Run repo secret scans and an optional mSCP check-only macOS audit. |
| `scripts/security-audit-personal.sh` | Audit personal Mac secret boundaries, identity state, and local drift. |
| `scripts/security-audit-devbox.sh` | Audit devbox secret boundaries, identity state, process-compose, and local drift. |
| `scripts/verify.sh` | Check the current machine bootstrap. |
| `scripts/verify-devbox.sh` | Check devbox supervisor, secret-file, and 1Password-token boundaries. |
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

For local posture checks, run `./scripts/security-audit.sh` and
`./scripts/security-audit-personal.sh`. On a shared devbox, run
`./scripts/security-audit-devbox.sh` from each devbox user instead of the
personal audit.
GitHub Actions runs Gitleaks and TruffleHog on pushes, pull requests, weekly
schedule, and manual dispatch. See [Security audits](docs/security-audits.md).

## License

MIT. See [License](LICENSE).
