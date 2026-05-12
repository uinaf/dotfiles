# Bootstrap Guide

Use this guide when installing or refreshing a Mac from `uinaf/dotfiles`.

The repo has two install profiles:

- `personal` for a human-operated Mac.
- `devbox` for a shared SSH-first agent host.

Run commands from the repo root unless a step says otherwise.

## First-Time Prerequisites

Install Apple Command Line Tools:

```zsh
xcode-select --install
```

Install Homebrew:

```zsh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Install the minimum tools needed to clone the repo:

```zsh
brew install git gh
gh auth login
```

Clone the repo:

```zsh
mkdir -p ~/projects/uinaf
gh repo clone uinaf/dotfiles ~/projects/uinaf/dotfiles
cd ~/projects/uinaf/dotfiles
```

## Personal Mac

Install Homebrew dependencies:

```zsh
./scripts/bootstrap/brew-bundle.sh personal
```

Install optional external tools:

```zsh
./scripts/bootstrap/install-blacksmith.sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
```

Link dotfiles and configure local state:

```zsh
./scripts/bootstrap/install.sh
./scripts/bootstrap/configure-git.sh --profile personal
mise install
./scripts/bootstrap/pull-repos.sh
```

Chrome vertical tabs are a local browser preference. Quit Chrome first, then:

```zsh
./scripts/bootstrap/configure-chrome.sh
```

Verify:

```zsh
./scripts/bootstrap/verify.sh --profile personal
./scripts/security/audit-personal.sh
```

## Devbox Mac

Install shared plus devbox Homebrew dependencies:

```zsh
./scripts/bootstrap/brew-bundle.sh devbox
```

Link dotfiles:

```zsh
./scripts/bootstrap/install.sh
mise install
```

Configure local Git identity from explicit values. Do not invent these for the
user:

```zsh
GIT_USER_NAME='Devbox Name' \
GIT_USER_EMAIL='devbox@example.com' \
GIT_SIGNING_KEY="$HOME/.ssh/devbox-key" \
OP_SSH_VAULT='Devbox Vault' \
  ./scripts/bootstrap/configure-git.sh --profile devbox --non-interactive
```

Devbox Git config writes identity and `/opt/homebrew` Git safe-directory state
to `~/.gitconfig.local`, not to the tracked shared config. When
`GIT_SIGNING_KEY` is a local private key path, devbox setup also writes a
managed `Host github.com` block to `~/.ssh/config.local` so normal
`git@github.com:...` remotes work over SSH in headless sessions without relying
on the 1Password GUI agent socket. Use `GIT_SSH_IDENTITY_FILE` when GitHub SSH
auth should use a different local key path than commit signing.

If the devbox runs long-lived OpenClaw or agent services, follow
[Devbox setup](devbox.md). The short version:

1. Store the 1Password service-account token in machine-local secret storage.
2. Use `scripts/devbox/install-env-refresh.sh` to install the root-owned env
   refresh helper.
3. Pipe the service-account token into `scripts/devbox/install-op-token.sh`.
4. Run services from process-compose with generated owner-only env files.

Verify each devbox user:

```zsh
./scripts/bootstrap/verify.sh --profile devbox
./scripts/devbox/verify.sh
./scripts/devbox/security-audit.sh
```

## Updating an Existing Machine

Pull the repo and rerun the relevant profile:

```zsh
cd ~/projects/uinaf/dotfiles
git pull --ff-only
./scripts/bootstrap/brew-bundle.sh personal
./scripts/bootstrap/install.sh
mise install
./scripts/bootstrap/verify.sh --profile personal
```

Use `devbox` instead of `personal` on shared agent hosts.

## Tizen

Tizen certificates, profiles, archives, and device keys are local secrets.
They do not belong in Git.

Helpers live under `scripts/tizen/`:

```zsh
./scripts/tizen/install.sh
./scripts/tizen/pack.sh
./scripts/tizen/restore.sh
./scripts/tizen/restore-from-1password.sh
```

`scripts/tizen/install.sh` verifies `tizen`, `sdb`, and
`package-manager-cli show-info`. It skips package catalog listing by default;
use `--show-pkgs` only when needed because Samsung's extension catalog download
can hang.

## Troubleshooting

- If `brew bundle check` fails, run the matching `brew-bundle.sh` profile and
  retry verification.
- If Git reports dubious ownership under `/opt/homebrew`, rerun
  `configure-git.sh` for the correct profile.
- If `git@github.com` fails on a devbox but the key is present, rerun
  `configure-git.sh --profile devbox --non-interactive` with
  `GIT_SIGNING_KEY` or `GIT_SSH_IDENTITY_FILE` pointing at the exported
  1Password-backed private key.
- If `op` works in the GUI but not SSH, check the devbox service-account flow
  in [Devbox setup](devbox.md) instead of exporting the token in shell startup.
- If `codex` is not installed yet, `install.sh` skips Codex defaults; rerun it
  after installing the shared Brewfile.
