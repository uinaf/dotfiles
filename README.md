# dotfiles

Public Mac bootstrap files for uinaf machines.

This repo owns the portable layer: Homebrew bundles, zsh startup, mise
runtimes, Git and SSH defaults, Codex defaults, editor settings, and setup and
audit scripts.

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

Install Apple Command Line Tools, Homebrew, `git`, and `gh`, then:

```zsh
gh auth login
mkdir -p ~/projects/uinaf
gh repo clone uinaf/dotfiles ~/projects/uinaf/dotfiles
cd ~/projects/uinaf/dotfiles

./scripts/bootstrap/brew-bundle.sh personal
./scripts/bootstrap/install.sh
./scripts/bootstrap/configure-git.sh --profile personal
mise install
./scripts/bootstrap/pull-repos.sh
./scripts/bootstrap/verify.sh --profile personal
```

For the full first-machine flow, devbox setup, Chrome vertical tabs, Blacksmith,
and Tizen notes, read [Bootstrap guide](docs/bootstrap.md).

## What Gets Linked

`./scripts/bootstrap/install.sh` links tracked files from `home/` into `$HOME`.
Existing files are moved aside with a timestamped `.backup.*` suffix.

| Surface | Tracked source | Local-only extension |
| --- | --- | --- |
| zsh | `home/.zshenv`, `home/.zprofile`, `home/.zshrc` | machine shell history and ad hoc local files |
| mise | `home/.config/mise/config.toml` | repo-local runtime files |
| Git | `home/.gitconfig` | `~/.gitconfig.local` |
| SSH | `home/.ssh/config` | `~/.ssh/config.local`, private keys |
| Codex | installer-managed defaults | auth, sessions, approvals, memory, worktrees |
| Editors | Zed and Ghostty defaults | app state, fonts, caches |

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

## Verification

Use repo checks before committing:

```zsh
./scripts/bootstrap/verify-repo.sh
```

To install the local pre-push guard for the fast repo gate:

```zsh
./scripts/bootstrap/install-git-hooks.sh
```

Use live-machine checks only on a machine that should actually use these
dotfiles:

```zsh
./scripts/bootstrap/verify.sh --profile personal
./scripts/bootstrap/verify.sh --profile devbox
```

For security posture:

```zsh
./scripts/security/audit.sh --skip-mscp
./scripts/security/audit-personal.sh
./scripts/devbox/security-audit.sh
```

See [Security audits](docs/security-audits.md) for the audit layers and macOS
Security Compliance Project flow.

## Docs Map

| Need | Read |
| --- | --- |
| Install or update a Mac | [Bootstrap guide](docs/bootstrap.md) |
| Operate a shared agent Mac mini | [Devbox setup](docs/devbox.md) |
| Help as an AI agent | [Agent guide](AGENTS.md) |
| Understand verification and CI | [Agent readiness](docs/agent-readiness.md) |
| Understand GitHub Actions | [GitHub pipelines](docs/github-pipelines.md) |
| Run security checks | [Security audits](docs/security-audits.md) |
| Contribute changes | [Contributing](CONTRIBUTING.md) |
| Report a vulnerability | [Security](SECURITY.md) |
| Find scripts | [Script guide](scripts/README.md) |

## Notes

- Install Berkeley Mono separately for the intended Ghostty and Zed font setup.
- Java is mise-managed through Temurin. Do not install a global Homebrew
  OpenJDK for this setup.
- Ruby is not global. Repos that need Ruby should declare it repo-locally.
- `~/.codex/AGENTS.md` is owned by
  [uinaf/agents](https://github.com/uinaf/agents), not this repo.

## License

MIT. See [License](LICENSE).
