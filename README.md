# dotfiles

Public Mac bootstrap files for uinaf machines.

This repo owns the portable layer: Homebrew bundles, chezmoi-managed zsh
startup, mise runtimes, Git and SSH defaults, Codex defaults, editor settings,
and setup and audit scripts.

It does not own secrets, identity, Codex auth/state, browser profiles, app
caches, dependency folders, build output, or project checkouts. Those stay
machine-local.

## Choose a Profile

| Profile | Use it for | Installs |
| --- | --- | --- |
| Shared | Base tools every uinaf Mac should have. | `Brewfile` |
| Personal | A human-operated laptop or desktop. | `Brewfile` + `Brewfile.personal` |
| Devbox | A shared Mac mini or SSH-first agent host. | `Brewfile` + `Brewfile.devbox` |

Most users want `personal`. Always-on agent hosts use `devbox`.

## Fast Path

Install Apple Command Line Tools, Homebrew, `git`, and `gh`, then clone the
repo:

```zsh
gh auth login
mkdir -p ~/projects/uinaf
gh repo clone uinaf/dotfiles ~/projects/uinaf/dotfiles
cd ~/projects/uinaf/dotfiles

./scripts/bootstrap/brew-bundle.sh personal
./scripts/bootstrap/install.sh
./scripts/bootstrap/configure-git.sh --profile personal
./scripts/bootstrap/configure-power.sh --profile personal
./scripts/app-store/personal.sh
mise trust
mise install
./scripts/bootstrap/pull-repos.sh
./scripts/verify/bootstrap.sh --profile personal
```

If `git` or `gh` is not available yet, or for the full first-machine flow,
devbox setup, Chrome vertical tabs, Blacksmith, and Tizen notes, read
[Bootstrap guide](docs/bootstrap.md).

`configure-power.sh` is a deliberate sudo step. `install.sh` stays user-level
and should not change system power policy implicitly.

## What Gets Installed

`./scripts/bootstrap/install.sh` applies tracked files from `chezmoi/` into
`$HOME` through `scripts/bootstrap/apply-dotfiles.sh`, then configures Codex
defaults when `codex` is available. Use [Chezmoi source state](docs/chezmoi.md)
for source naming rules and safe edit workflow. Use [Mise tasks](docs/mise.md)
for the split between repo tasks and machine runtime pins.

| Surface | Tracked source | Local-only extension |
| --- | --- | --- |
| zsh | `chezmoi/dot_zshenv`, `chezmoi/dot_zprofile`, `chezmoi/dot_zshrc` | machine shell history and ad hoc local files |
| mise | `chezmoi/private_dot_config/mise/config.toml` | repo-local runtime files |
| Git | `chezmoi/dot_gitconfig` | `~/.gitconfig.local` |
| SSH | `chezmoi/private_dot_ssh/private_config` | `~/.ssh/config.local`, private keys |
| Codex | installer-managed defaults | auth, sessions, approvals, memory, worktrees |
| Editors | chezmoi-managed Zed and Ghostty defaults | app state, fonts, caches |

## Local State Boundaries

Keep these out of Git:

- Git identity, signing keys, and 1Password SSH agent vault selection.
- 1Password service-account tokens and item references.
- SSH private keys, certificates, Tizen archives, and device keys.
- Codex auth, Browser approvals, sessions, caches, worktrees, and app state.
- Browser profiles, Docker/Colima state, dependency folders, and build output.

For always-on agent hosts, use the secret model in [Devbox setup](docs/devbox.md):
service-account tokens live in machine-local storage, generated runtime env
files are owner-only, and normal shells do not export long-lived tokens.

## Personalization

`Brewfile.personal` is the shared human-operated Mac profile, not a private app
wishlist. Keep one-machine tweaks in local config files, keep durable personal
preferences in a fork, and send focused pull requests for changes that should
become part of the shared uinaf bootstrap.

## Verification

Use repo checks before committing:

```zsh
./scripts/verify/repo.sh
```

Equivalent mise task:

```zsh
mise trust
mise run verify
mise run verify:fast
```

To install the local pre-push guard for the fast repo gate:

```zsh
./scripts/bootstrap/install-git-hooks.sh
```

Use live-machine checks only on a machine that should actually use these
dotfiles:

```zsh
./scripts/verify/bootstrap.sh --profile personal
./scripts/verify/bootstrap.sh --profile devbox
```

For security posture:

```zsh
./scripts/audit/repo.sh --skip-mscp
mise run audit:repo
./scripts/audit/host.sh
./scripts/audit/personal.sh
./scripts/audit/devbox.sh
```

See [Security audits](docs/security-audits.md) for the audit layers, Lynis host
audit, and macOS Security Compliance Project flow.

## Docs Map

| Need | Read |
| --- | --- |
| Install or update a Mac | [Bootstrap guide](docs/bootstrap.md) |
| Operate a shared agent Mac mini | [Devbox setup](docs/devbox.md) |
| Understand dotfile source state | [Chezmoi source state](docs/chezmoi.md) |
| Understand mise tasks and runtime pins | [Mise tasks](docs/mise.md) |
| Help as an AI agent | [Agent guide](AGENTS.md) |
| Understand verification and CI | [Agent readiness](docs/agent-readiness.md) |
| Understand GitHub Actions | [GitHub pipelines](docs/github-pipelines.md) |
| Run security checks | [Security audits](docs/security-audits.md) |
| Build React Native apps | [React Native](docs/react-native.md) |
| Contribute changes | [Contributing](CONTRIBUTING.md) |
| Report a vulnerability | [Security](SECURITY.md) |
| Find scripts | [Script guide](scripts/README.md) |

## License

MIT. See [License](LICENSE).
