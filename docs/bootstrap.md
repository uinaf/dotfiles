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
mise trust
```

`mise trust` is a local approval for this checkout's `mise.toml`. Run it before
`mise install`, `mise tasks`, or `mise run ...`; otherwise mise refuses to load
the repo config.

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
can install files from an archive checkout. After Homebrew, `git`, and `gh`
are installed, replace the archive with a real clone so updates, diffs, hooks,
and contribution checks work normally:

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

Editor and terminal defaults prefer `Berkeley Mono Variable`. This repo does
not install it because it is a licensed font; ask the human to provide and
install it when available. The shared Brewfile installs `FiraCode Nerd Font` as
the free fallback for Ghostty and Zed.

Codex app appearance is manual app state, not repo-managed config. After
installing the Codex app, open its settings and set:

- code font: `Berkeley Mono Variable`
- UI font size: `14 px`
- code font size: `14 px`
- Font Smoothing: on

`./scripts/bootstrap/install.sh` configures Codex defaults in
`~/.codex/config.toml`, including `forced_login_method = "chatgpt"` so Codex
uses ChatGPT subscription access instead of API-key billing. It does not manage
Codex auth tokens, sessions, approvals, or app state.

The same install step also runs the agent worktree mise trust helper. Use the
matching task in [Mise tasks](mise.md#task-namespaces) to refresh that local
trust after new worktrees are created.

Remote Codex connections are also manual user config. If the machine should use
them, ask the human to add this to `~/.codex/config.toml`:

```toml
[features]
remote_connections = true
```

Apply dotfiles and configure local state:

```zsh
./scripts/bootstrap/install.sh
./scripts/bootstrap/configure-git.sh --profile personal
./scripts/bootstrap/configure-power.sh --profile personal
./scripts/bootstrap/configure-spotlight.sh
mise trust
mise install
./scripts/bootstrap/pull-repos.sh
```

The dotfile step applies the repo-local chezmoi source state from `chezmoi/`.
Preview it with `./scripts/bootstrap/apply-dotfiles.sh --dry-run --verbose`
when changing source-state files. The power step disables system, display, and
disk sleep only while the Mac is plugged in. Battery settings stay under macOS
defaults so laptops still sleep normally when unplugged. It prompts for sudo;
`install.sh` remains a user-level dotfile and Codex-defaults step.
`configure-spotlight.sh` is the same host-wide baseline for personal and
devbox Macs: it disables indexing on mounted volumes without deleting existing
index data.

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

Apply dotfiles:

```zsh
./scripts/bootstrap/install.sh
./scripts/bootstrap/configure-power.sh --profile devbox
./scripts/bootstrap/configure-spotlight.sh
mise trust
mise install
```

The power step keeps plugged-in devboxes awake for agents, remote access, and
always-on dashboards. It leaves battery settings untouched and prompts for sudo
instead of hiding system changes inside `install.sh`.
The Spotlight step is the same host-wide baseline used by personal Macs.

Configure local Git identity from explicit values. Do not invent these for the
user. On headless devboxes, prefer a human-provisioned local SSH key file over
GUI SSH agents:

```zsh
GIT_USER_NAME='Devbox Name' \
GIT_USER_EMAIL='devbox@example.com' \
GIT_SIGNING_KEY="$HOME/.ssh/devbox-key" \
  ./scripts/bootstrap/configure-git.sh --profile devbox --non-interactive
```

Only set `OP_SSH_VAULT` on human-operated machines where the 1Password SSH
agent is installed and reachable from that shell/session.

Devbox Git config writes identity and `/opt/homebrew` Git safe-directory state
to `~/.gitconfig.local`, not to the tracked shared config. When
`GIT_SIGNING_KEY` is a local private key path, devbox setup also writes a
managed `Host github.com` block to `~/.ssh/config.local` so normal
`git@github.com:...` remotes work over SSH in headless sessions without relying
on a GUI agent socket. Use `GIT_SSH_IDENTITY_FILE` when GitHub SSH auth should
use a different local key path than commit signing.

If the devbox runs long-lived workspace or agent services, follow
[Devbox setup](devbox.md). The short version: use Infisical Universal Auth
machine identities at the command boundary, keep human Infisical CLI sessions
off agent devboxes, keep long-lived service tokens out of default shells and
process-compose YAML, and run services through process-compose with explicit
secret-manager commands or local owner-only config. Agent SSH keys may live in
Infisical under the devbox secret boundary and should be retrieved only into
owner-only local key files or the command environment that needs them.

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
./scripts/bootstrap/configure-power.sh --profile personal
./scripts/bootstrap/configure-spotlight.sh
mise trust
mise install
./scripts/verify/bootstrap.sh --profile personal
```

Use `devbox` instead of `personal` on shared agent hosts.

## React Native

Xcode tvOS simulators, Android SDK, Android TV system images, CocoaPods, and
Fastlane are per-machine state set up by hand. See
[React Native](react-native.md) for the manual steps.

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
- If `chezmoi` is missing, rerun `./scripts/bootstrap/brew-bundle.sh` for the
  correct profile before `./scripts/bootstrap/install.sh`.
- If Git reports dubious ownership under `/opt/homebrew`, rerun
  `configure-git.sh` for the correct profile.
- If `git@github.com` fails on a devbox but the key is present, rerun
  `configure-git.sh --profile devbox --non-interactive` with
  `GIT_SIGNING_KEY` or `GIT_SSH_IDENTITY_FILE` pointing at the exported
  1Password-backed private key.
- If shared env access is missing over SSH, check the Infisical/devbox contract
  in [Devbox setup](devbox.md) instead of exporting service tokens in shell
  startup.
- If `codex` is not installed yet, `install.sh` skips Codex defaults; rerun it
  after installing the shared Brewfile.
