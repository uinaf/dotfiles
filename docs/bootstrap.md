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

## Gitless First Fetch

Use this only when a fresh Mac cannot run `git` or `gh` yet. macOS ships enough
tools to fetch a public GitHub archive, which lets a human or agent inspect the
bootstrap files before running anything:

```zsh
mkdir -p ~/projects/uinaf
curl -fL https://github.com/uinaf/dotfiles/archive/refs/heads/main.zip \
  -o /tmp/uinaf-dotfiles-main.zip
ditto -x -k /tmp/uinaf-dotfiles-main.zip ~/projects/uinaf
mv ~/projects/uinaf/dotfiles-main ~/projects/uinaf/dotfiles
cd ~/projects/uinaf/dotfiles
```

Archive checkouts are disposable. They are acceptable for reading docs and
running the first public bootstrap scripts, and `scripts/bootstrap/install.sh`
can link files from an archive checkout. After Homebrew, `git`, and `gh` are
installed, replace the archive with a real clone so updates, diffs, hooks, and
contribution checks work normally:

```zsh
cd ~/projects/uinaf
mv dotfiles dotfiles.archive.$(date +%Y%m%d%H%M%S)
gh repo clone uinaf/dotfiles dotfiles
cd dotfiles
```

Do not run identity, signing-key, or secret setup from guessed values just
because the repo was fetched this way. Keep using the `personal` or `devbox`
profile steps below.

## Personal Mac

Install Homebrew dependencies:

```zsh
./scripts/bootstrap/brew-bundle.sh personal
```

Install personal Mac App Store apps and remove bundled apps this setup does not
use:

```zsh
./scripts/app-store/personal.sh
```

This uses `mas`, requires the interactive user to be signed into the App Store,
and may ask for the local account password during install or uninstall.

Install optional external tools:

```zsh
./scripts/bootstrap/install-blacksmith.sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
```

Editor and terminal defaults prefer `Berkeley Mono Variable`, which is a
licensed font and must be installed manually when available. The shared Brewfile
installs `FiraCode Nerd Font` as the free fallback for Ghostty and Zed.

Codex app appearance is manual app state, not repo-managed config. After
installing the Codex app, open its settings and set:

- code font: `Berkeley Mono Variable`
- UI font size: `14 px`
- code font size: `14 px`
- Font Smoothing: on

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
./scripts/verify/bootstrap.sh --profile personal
./scripts/audit/host.sh
./scripts/audit/personal.sh
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
user. On headless devboxes, prefer a local SSH key file exported from
1Password over the 1Password GUI SSH agent:

```zsh
GIT_USER_NAME='Devbox Name' \
GIT_USER_EMAIL='devbox@example.com' \
GIT_SIGNING_KEY="$HOME/.ssh/devbox-key" \
  ./scripts/bootstrap/configure-git.sh --profile devbox --non-interactive
```

Only set `OP_SSH_VAULT` when the 1Password SSH agent is installed and reachable
from that shell/session.

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
2. Use `scripts/secrets/install-env-refresh.sh` to install the root-owned env
   refresh helper.
3. Pipe the service-account token into `scripts/secrets/install-op-token.sh`.
4. Run services from process-compose with generated owner-only env files.

Verify each devbox user:

```zsh
./scripts/verify/bootstrap.sh --profile devbox
./scripts/audit/host.sh
./scripts/verify/devbox-services.sh
./scripts/audit/devbox.sh
```

## Updating an Existing Machine

Pull the repo and rerun the relevant profile:

```zsh
cd ~/projects/uinaf/dotfiles
git pull --ff-only
./scripts/bootstrap/brew-bundle.sh personal
./scripts/bootstrap/install.sh
mise install
./scripts/verify/bootstrap.sh --profile personal
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
