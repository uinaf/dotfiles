# Bootstrap Guide

Use this guide when installing or refreshing a Mac from this repository.

The repo has three per-user profiles:

- `workstation` for a human-operated Mac.
- `devbox` for a remote coding identity on an SSH-first host.
- `assistant` for an unattended assistant or platform-service identity.

The role contract and host/user boundary are defined in [User profiles](profiles.md).
Cursor Agent CLI is required for workstation and devbox profiles and installed per user with
`./scripts/bootstrap/install-cursor-agent.sh`. The desktop app is not managed by
this repository. Devbox shells use Cursor's owner-local file credential store
because SSH sessions cannot depend on an unlocked macOS login keychain.

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

Install the minimum tools needed to clone the repo on a workstation Mac:

```zsh
brew install git gh
gh auth login
```

On a shared devbox, scope the group-safe umask directly because the repo
wrapper is not available until after this first clone:

```zsh
(umask 0002; brew install git gh)
gh auth login
```

Clone the repo:

```zsh
mkdir -p ~/projects
gh repo clone uinaf/dotfiles ~/projects/dotfiles
cd ~/projects/dotfiles
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
mkdir -p ~/projects
curl -fL https://github.com/uinaf/dotfiles/archive/refs/heads/main.zip \
  -o /tmp/dotfiles-main.zip
ditto -x -k /tmp/dotfiles-main.zip ~/projects
mv ~/projects/dotfiles-main ~/projects/dotfiles
cd ~/projects/dotfiles
```

Archive checkouts are disposable. They are acceptable for reading docs and
running the first public bootstrap scripts, and `scripts/bootstrap/install.sh`
can install files from an archive checkout. After Homebrew, `git`, and `gh`
are installed, replace the archive with a real clone so updates, diffs, hooks,
and contribution checks work normally:

```zsh
cd ~/projects
mv dotfiles dotfiles.archive.$(date +%Y%m%d%H%M%S)
gh repo clone uinaf/dotfiles dotfiles
cd dotfiles
```

Do not run identity, signing-key, or secret setup from guessed values just
because the repo was fetched this way. Keep using the selected
profile steps below.

## Workstation Mac

Install Homebrew dependencies:

```zsh
./scripts/bootstrap/brew-bundle.sh workstation
./scripts/bootstrap/install-cursor-agent.sh
```

Install workstation Mac App Store apps and remove bundled apps this setup does not
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
install it when available. Ghostty and Zed fall back to `Menlo`, which ships
with macOS and does not require another font package.

The managed Ghostty config enables its `ssh-env` and `ssh-terminfo` shell
integration features. Interactive SSH connections install Ghostty's terminfo
entry on the remote host when possible and fall back to `xterm-256color` when
installation is unavailable. See [Ghostty SSH
integration](https://ghostty.org/docs/features/ssh).

The ChatGPT desktop app includes Codex. Its Codex appearance is manual app
state, not repo-managed config. After installing ChatGPT, open its Codex
settings and set:

- code font: `Berkeley Mono Variable`
- UI font size: `14 px`
- code font size: `14 px`
- Font Smoothing: on

`./scripts/bootstrap/install.sh` configures Codex defaults in
`~/.codex/config.toml`, including `forced_login_method = "chatgpt"` so Codex
uses ChatGPT subscription access instead of API-key billing. It does not manage
Codex auth tokens, sessions, approvals, or app state.

The same install step installs or updates GitHub's official `github/gh-stack`
extension through `gh extension install --force`. GitHub CLI authentication and
other extensions remain machine-local.

The same install step applies mise's trusted Codex and Claude worktree roots
and runs the agent worktree mise trust helper. Use the matching task in
[Mise tasks](mise.md#task-namespaces) to refresh local trust after new
worktrees are created.

Remote Codex connections are also manual user config. If the machine should use
them, ask the human to add this to `~/.codex/config.toml`:

```toml
[features]
remote_connections = true
```

Apply dotfiles and configure local state:

```zsh
./scripts/bootstrap/install.sh --profile workstation
./scripts/bootstrap/configure-git.sh --profile workstation
./scripts/bootstrap/configure-power.sh --profile workstation
./scripts/bootstrap/configure-spotlight.sh
mise trust
mise install
```

The developer mise config pins Node, installs the default native pnpm release, and
installs the exact shared npm, Playwright CLI, and Vite+ versions. `install.sh`
also replaces a stale Corepack shim on an existing Node installation; `mise
install` remains required for a fresh runtime or CLI version change.

The dotfile step applies the repo-local chezmoi source state from `chezmoi/`.
Preview it with `./scripts/bootstrap/apply-dotfiles.sh --profile workstation --dry-run --verbose`
when changing source-state files. The power step disables system, display, and
disk sleep only while the Mac is plugged in. Battery settings stay under macOS
defaults so laptops still sleep normally when unplugged. It prompts for sudo;
`install.sh` remains a user-level dotfile and Codex-defaults step.
`configure-spotlight.sh` is the same host-wide baseline for workstation and
devbox Macs: it disables indexing on mounted volumes without deleting existing
index data.

Chrome vertical tabs are a local browser preference. Quit Chrome first, then:

```zsh
./scripts/bootstrap/configure-chrome.sh
```

### Local Git Signing Key

Workstation Macs may use an existing 1Password SSH key for autonomous Git signing
without depending on the 1Password SSH agent at commit time. This is a one-time
human bootstrap: open the SSH Key item in 1Password, export its private key in
OpenSSH format without a passphrase, and save it to an owner-only path such as
`~/.ssh/workstation_ed25519`. Leaving the export unencrypted is required for
unattended signing and means any process running as the local user can use the
key. Keep 1Password as the recovery copy and do not copy the exported file into
this repository.

Derive the public key and lock the file permissions before configuration:

```zsh
chmod 0600 ~/.ssh/workstation_ed25519
ssh-keygen -y -f ~/.ssh/workstation_ed25519 > ~/.ssh/workstation_ed25519.pub
chmod 0644 ~/.ssh/workstation_ed25519.pub
```

Configure the exported key for commit signing and, when the same key is already
registered for GitHub SSH authentication, for GitHub pushes:

```zsh
GIT_SIGNING_KEY="$HOME/.ssh/workstation_ed25519" \
GIT_SSH_IDENTITY_FILE="$HOME/.ssh/workstation_ed25519" \
  ./scripts/bootstrap/configure-git.sh --profile workstation
```

GitHub tracks authentication and signing registrations separately even when
they contain the same public key. The key must already be present in both roles
for SSH pushes and `Verified` commits to work. This dual-use setup is convenient,
but revoking or rotating the local key affects both operations.

The generated Git config signs directly from the unencrypted local private key.
The dotfile install provides an owner-only signing program under
`~/.local/libexec/dotfiles/`; Git uses it to clear `SSH_AUTH_SOCK` before invoking
`ssh-keygen`, so ambient agents are never part of commit signing. Encrypted,
public-key-only, and 1Password-backed signing are unsupported. The generated
`~/.ssh/github.config` block uses the same key for `github.com` without routing
through the 1Password agent. The tracked SSH entrypoint includes that dedicated
file before the untouched `~/.ssh/config.local`, so local global directives and
host-specific configuration keep their original scope. Setup migrates only the
old marker-delimited GitHub block out of `config.local`; if an unmarked
`Host github.com` entry already exists, it stops before changing Git state and
asks you to resolve the local configuration explicitly. It also stops if
`~/.ssh/github.config` already exists without the managed markers; move
that file aside or migrate its directives to `~/.ssh/config.local` before
rerunning. OpenSSH keeps
file-backed `IdentityFile` values additive, so wildcard local identities may
still appear after the exported key; the exported key remains first and
`IdentityAgent none` prevents agent-backed keys, including 1Password keys, from
being used for GitHub.

Verify:

```zsh
./scripts/verify/bootstrap.sh --profile workstation
./scripts/audit/host.sh
./scripts/audit/workstation.sh
```

## Devbox Mac

The human owner profile may opt into the compact desktop baseline. It is not
part of the shared agent-user bootstrap:

```zsh
./scripts/bootstrap/configure-desktop.sh
./scripts/verify/bootstrap.sh --profile devbox --desktop
```

This keeps the built-in black system wallpaper, hidden desktop icons and
widgets, an auto-hiding compact Dock, no recent apps, and Google Chrome as the
only persistent Dock app. Run it only from the logged-in owner account.

Install shared plus devbox Homebrew dependencies:

```zsh
./scripts/bootstrap/brew-bundle.sh devbox
./scripts/bootstrap/install-cursor-agent.sh
./scripts/bootstrap/install-blacksmith.sh
```

Run every other Homebrew mutation on a shared devbox through the repo wrapper:

```zsh
./scripts/bootstrap/brew-devbox.sh upgrade
./scripts/bootstrap/brew-devbox.sh upgrade --cask
```

The wrapper scopes a group-safe umask to the Homebrew child process. The
devbox bundle command uses it internally; it does not change the caller's
shell umask. Run these commands once from the owning admin identity, then run
the devbox bootstrap verification as every Unix identity.

Blacksmith uses its official per-user installer rather than Homebrew and
self-updates from `~/.local/bin`.

Apply dotfiles:

```zsh
./scripts/bootstrap/install.sh --profile devbox
./scripts/bootstrap/configure-power.sh --profile devbox
./scripts/bootstrap/configure-spotlight.sh
mise trust
mise install
```

The developer mise config pins Node, installs the default native pnpm release, and
installs the exact shared npm, Playwright CLI, and Vite+ versions. `install.sh`
replaces a stale Corepack shim on an existing Node installation, while `mise
install` installs missing runtimes and CLIs.

The power step keeps plugged-in devboxes awake for agents, remote access, and
always-on dashboards. It leaves battery settings untouched and prompts for sudo
instead of hiding system changes inside `install.sh`.
The Spotlight step is the same host-wide baseline used by workstation Macs.

Configure local Git identity from explicit values. Do not invent these for the
user. On headless devboxes, prefer a human-provisioned local SSH key file over
GUI SSH agents:

```zsh
GIT_USER_NAME='Devbox Name' \
GIT_USER_EMAIL='devbox@example.com' \
GIT_SIGNING_KEY="$HOME/.ssh/devbox-key" \
  ./scripts/bootstrap/configure-git.sh --profile devbox --non-interactive
```

Commit signing requires a human-provisioned, owner-only, unencrypted local SSH
private key. Agent-backed signing is unsupported.

Devbox Git config writes identity and `/opt/homebrew` Git safe-directory state
to `~/.gitconfig.local`, not to the tracked shared config. When
`GIT_SIGNING_KEY` is a local private key path, devbox setup also writes a
managed `Host github.com` block to `~/.ssh/github.config` so normal
`git@github.com:...` remotes work over SSH in headless sessions without relying
on a GUI agent socket. Use `GIT_SSH_IDENTITY_FILE` when GitHub SSH auth should
use a different local key path than commit signing.

If the devbox runs long-lived workspace or agent services, follow
[Devbox setup](devbox.md). The short version: run
`./scripts/secrets/configure-infisical-devbox.sh` once with a human-supplied
Universal Auth client ID/secret, keep human Infisical CLI sessions off agent
devboxes, keep long-lived tokens out of default shells and process-compose YAML,
and run routine secret-aware commands through
`./scripts/secrets/infisical-devbox-run.sh`.

Verify each devbox user:

```zsh
./scripts/verify/bootstrap.sh --profile devbox
./scripts/audit/host.sh
./scripts/verify/devbox-services.sh
./scripts/audit/devbox.sh
```

## Assistant User

An assistant is a minimal unattended Unix identity, not a coding devbox. On a
shared Mac, an authorized host administrator installs the Homebrew layers once:

```zsh
./scripts/bootstrap/brew-bundle.sh assistant
```

Run the user-local setup as the assistant identity:

```zsh
git clone https://github.com/uinaf/dotfiles.git ~/.local/src/dotfiles
cd ~/.local/src/dotfiles
./scripts/bootstrap/install.sh --profile assistant
mise trust
mise install
./scripts/secrets/configure-infisical-devbox.sh
GIT_USER_NAME='Workload Name' \
GIT_USER_EMAIL='APP_BOT_NOREPLY_EMAIL' \
  ./scripts/bootstrap/configure-git.sh --profile assistant --non-interactive
./scripts/verify/bootstrap.sh --profile assistant
```

Do not install Cursor Agent or configure Codex desktop defaults for an
assistant. Start with a dedicated Unix user and a clean home. The assistant
`configure-git.sh` flow writes only workload commit authorship; it rejects
signing keys and GitHub SSH identity files.

GitHub authentication is intentionally not configured by the assistant
profile. The assistant can create unsigned local commits with its workload
identity, but unattended fetch/push remains disabled until the platform layer
provisions a workload-owned GitHub App or another scoped machine identity.
Token minting and Git transport are follow-up platform work; do not persist a
human account or ad hoc token in Git config, `gh auth`, shell startup, or a
process manager to bridge that gap.

Bootstrap verification checks the managed workload identity and common
user-home credential locations. It does not prove the absence of identity in
system configuration or arbitrary repository-local config. Treat a clean home
plus scoped runtime credentials as the boundary. Run
`./scripts/verify/assistant-git-boundary.sh` directly when investigating a
failure.

The profile provides minimal Node, Python, uv, browser, media, and process
supervision support. The owning workload installs and verifies OpenClaw,
Hermes, providers, channels, and service definitions. Profile application does
not remove old developer packages or credentials; audit those separately after
the retained workload passes its runtime checks.

## Updating an Existing Machine

Pull the repo and rerun the relevant profile:

```zsh
cd ~/projects/dotfiles
git pull --ff-only
./scripts/bootstrap/brew-bundle.sh workstation
./scripts/bootstrap/install.sh --profile workstation
./scripts/bootstrap/configure-power.sh --profile workstation
./scripts/bootstrap/configure-spotlight.sh
mise trust
mise install
./scripts/verify/bootstrap.sh --profile workstation
```

Use the target Unix user's `devbox` or `assistant` role instead when appropriate.

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
- If devbox verification reports an unreadable Homebrew payload, reinstall
  the owning formula or cask through `brew-devbox.sh`; use a targeted
  permission repair only when Homebrew itself cannot run. Do not recursively
  change permissions across the Homebrew prefix.
- If `chezmoi` is missing, rerun `./scripts/bootstrap/brew-bundle.sh` for the
  correct profile before `./scripts/bootstrap/install.sh`.
- If Git reports dubious ownership under `/opt/homebrew`, rerun
  `configure-git.sh` for the correct profile.
- If `git@github.com` fails on a devbox but the key is present, rerun
  `configure-git.sh --profile devbox --non-interactive` with
  `GIT_SIGNING_KEY` or `GIT_SSH_IDENTITY_FILE` pointing at the owner-only local
  private key file.
- If shared env access is missing over SSH, check the Infisical/devbox contract
  in [Devbox setup](devbox.md) instead of exporting service tokens in shell
  startup.
- If `codex` is not installed yet for a workstation or devbox user,
  `install.sh` skips Codex defaults; rerun it after installing the developer
  Homebrew layer.
- If macOS Gatekeeper blocks an embedded Cursor Agent `.node` module, remove a
  Homebrew `cursor-cli` cask installation and run
  `./scripts/bootstrap/install-cursor-agent.sh`. The repo intentionally uses
  Cursor's official per-user installer instead of recursively removing
  quarantine attributes from a Homebrew cask.
