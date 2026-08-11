# Bootstrap Guide

Use this guide when installing or refreshing a Mac from this repository.

The repo has six per-user profiles:

- `workstation` for a portable human-operated development Mac.
- `personal-workstation` for a workstation plus personal packages and skills.
- `personal-devbox` for a devbox plus headless personal tools and skills.
- `devbox` for a remote coding identity on an SSH-first host.
- `assistant` for an unattended persona or agent identity.
- `service` for a non-persona managed workload identity.

The role contract and host/user boundary are defined in [User profiles](profiles.md).
Cursor Agent CLI is required for personal-workstation, personal-devbox, workstation, and devbox profiles
and installed by `./scripts/bootstrap/install.sh`. Cursor desktop belongs to
the workstation Homebrew layer. Devbox shells use Cursor's
owner-local file credential store because SSH sessions cannot depend on an
unlocked macOS login keychain.

Run commands from the repo root unless a step says otherwise.

Keep the SOPS and age CLIs in the portable Homebrew baseline. Require a
per-user SOPS age identity only for profiles and workflows that decrypt
encrypted material (`personal-devbox`, `devbox`, `assistant`, `service`, and any vault or sudo
consumer). Portable `workstation` and `personal-workstation` boots can pass readiness
without an identity; decryption stays fail-closed until one is provisioned.
When you do create an identity, follow [Identity provisioning](identities.md),
back it up through an approved human recovery system, and verify the restored
recipient before protecting live ciphertext.

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
```

The selected Homebrew profile installs mise. Trust this checkout after the
bundle step and before `mise tasks` or `mise run ...`.

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

## Human Workstation Macs

Use `workstation` for the portable developer baseline or when another trusted
system owns selected software. Use `personal-workstation` when this repository
should also own the personal package and skill layers.

Install Homebrew dependencies:

```zsh
profile=workstation # use personal-workstation for the personal layers
./scripts/bootstrap/brew-bundle.sh "$profile"
```

For externally supplied Brewfile entries, configure the local validation
contract in [User profiles](profiles.md#externally-managed-homebrew-capabilities).

On `personal-workstation` only, install Mac App Store apps and remove bundled apps this
setup does not use:

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

The personal-workstation profile's ChatGPT desktop app includes Codex. Its Codex appearance
is manual app state, not repo-managed config. After installing ChatGPT, open
its Codex settings and set:

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

It also runs the machine-global instruction and additive skill sync described
in [Agent setup](agents.md).

Remote Codex connections are also manual user config. If the machine should use
them, ask the human to add this to `~/.codex/config.toml`:

```toml
[features]
remote_connections = true
```

Apply dotfiles and configure local state:

```zsh
profile=workstation # use personal-workstation for the personal layers
mise trust
./dotfiles diff "$profile"
./dotfiles apply "$profile"
# Optional for workstation/personal-workstation; required for secret-consuming profiles:
# ./scripts/secrets/configure-sops-age-identity.sh
./scripts/bootstrap/configure-git.sh --profile "$profile"
./scripts/bootstrap/configure-power.sh --profile "$profile"
./scripts/bootstrap/configure-spotlight.sh
```

The installer applies the profile's dotfiles, installs its mise runtimes, then
configures the remaining integrations.

The developer mise config pins Node, enables the stable Corepack-managed pnpm
default, and installs exact shared npm and Playwright CLI versions. Vite+ stays
repository-local.

The dotfile step applies the repo-local chezmoi source state from `chezmoi/`.
Preview the whole per-user flow with `./dotfiles diff "$profile"`. The power
step disables system, display, and disk sleep only while the Mac is plugged in.
Battery settings stay under macOS defaults so laptops still sleep normally
when unplugged. It prompts for sudo;
`./dotfiles apply` remains a user-level convergence step.
`configure-spotlight.sh` is the same host-wide baseline for workstation and
devbox Macs: it disables indexing on mounted volumes without deleting existing
index data.

Chrome vertical tabs are a local browser preference. Quit Chrome first, then:

```zsh
./scripts/bootstrap/configure-chrome.sh
```

### Git Identity

Configure explicit authorship, local SSH signing, and GitHub SSH authentication
through the developer flow in [Identity provisioning](identities.md#developer-git-and-ssh).
Keep the private key owner-only and outside this repository.

Verify:

```zsh
./dotfiles check "$profile"
./scripts/audit/host.sh
mise run audit workstation
```

## Devbox Mac

Use `devbox` for the standard shared-host contract. Use `personal-devbox` for
the same host shape plus additive headless personal tools and skills.

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
profile=devbox # use personal-devbox for headless personal tools and skills
./scripts/bootstrap/brew-bundle.sh "$profile"
./scripts/bootstrap/install-blacksmith.sh
```

Run every other Homebrew mutation on a shared devbox through the repo wrapper:

```zsh
./scripts/bootstrap/brew-devbox.sh upgrade
./scripts/bootstrap/brew-devbox.sh upgrade --cask
```

The wrapper requires the current Unix user to own the Homebrew prefix, then
scopes a group-safe umask to the Homebrew child process. After every attempted
mutation it restores group read and traverse permissions on prefix-owner-owned
content, including macOS symlinks, while preserving Homebrew's exit status. It
does not change content owned by another Unix identity. The devbox bundle
command uses the wrapper internally; it does not change the caller's shell
umask. Run these commands once from the owning admin identity, then run the
devbox bootstrap verification as every Unix identity. Verification disables
Homebrew auto-update so a read-only package check cannot mutate the shared
checkout.

Blacksmith uses its official per-user installer rather than Homebrew and
self-updates from `~/.local/bin`.

Apply dotfiles:

```zsh
mise trust
./dotfiles diff "$profile"
./dotfiles apply "$profile"
./scripts/secrets/configure-sops-age-identity.sh
./scripts/bootstrap/configure-power.sh --profile "$profile"
./scripts/bootstrap/configure-spotlight.sh
```

The installer applies the developer runtime pins before typed agent sync. Mise
installs Node, the stable Corepack-managed pnpm default, and exact shared npm
and Playwright CLI versions. Vite+ stays repository-local.

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
  ./scripts/bootstrap/configure-git.sh --profile "$profile" --non-interactive
```

See [Developer Git and SSH](identities.md#developer-git-and-ssh) for key
requirements, separate authentication keys, and the managed GitHub SSH block.

If the devbox runs long-lived workspace or agent services, follow
[Devbox setup](devbox.md). Provision and back up the dedicated SOPS age
identity, keep plaintext out of default shells and service configuration, and
let each workspace own its narrow SOPS consumers.

Verify each devbox user:

```zsh
./dotfiles check "$profile"
./scripts/audit/host.sh
./scripts/verify/devbox-services.sh
mise run audit devbox
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
mise trust
./dotfiles diff assistant
./dotfiles apply assistant
./scripts/secrets/configure-sops-age-identity.sh
GIT_USER_NAME='Workload Name' \
GIT_USER_EMAIL='APP_BOT_NOREPLY_EMAIL' \
  ./scripts/bootstrap/configure-git.sh --profile assistant --non-interactive
./scripts/bootstrap/configure-assistant-github-app.sh \
  --name example-app \
  --app-id APP_ID \
  --installation-id INSTALLATION_ID \
  --repo github.com/example/workspace
./dotfiles check assistant
```

Start assistants as dedicated Unix users with clean homes. Their Git flow
writes unsigned workload authorship and configures exact-repository GitHub App
access; see [Assistant GitHub App](identities.md#assistant-github-app). The
workload repository owns additional runtimes, providers, channels, and service
definitions.

Bootstrap verification checks the managed Git base, `gh-app-auth` dispatch,
and workload identity. Run `./scripts/verify/assistant-git-boundary.sh` for the
standalone workload boundary check.

When an assistant runs OpenClaw as a system LaunchDaemon, install the explicit
restart capability with `--allow-openclaw-restart` as documented in
[Devbox setup](devbox.md#supervisor). This grants only passwordless restart of
that user's exact gateway label; the workload owns its executable wrapper and
OpenClaw lifecycle policy.

## Service User

A service is a minimal non-persona, non-admin Unix identity. It does not
inherit assistant browser, Node, GitHub App, or coding-agent setup. An
authorized host administrator installs its Homebrew layers once:

```zsh
./scripts/bootstrap/brew-bundle.sh service
```

Run the user-local setup as the service identity:

```zsh
git clone https://github.com/uinaf/dotfiles.git ~/projects/dotfiles
cd ~/projects/dotfiles
mise trust
./dotfiles diff service
./dotfiles apply service
./scripts/secrets/configure-sops-age-identity.sh
GIT_USER_NAME='Service Name' \
GIT_USER_EMAIL='service@example.invalid' \
  ./scripts/bootstrap/configure-git.sh --profile service --non-interactive
./dotfiles check service
```

The workload repository owns service authentication, runtimes, containers,
supervision, health checks, backups, and recovery. Keep playground workloads
containerized and bounded there instead of expanding the service profile into
a remote coding or host-administrator role.

## Updating an Existing Machine

Pull the repo and rerun the relevant profile:

```zsh
cd ~/projects/dotfiles
git pull --ff-only
profile=workstation # use personal-workstation for the personal layers
./scripts/bootstrap/brew-bundle.sh "$profile"
mise trust
./dotfiles diff "$profile"
./dotfiles apply "$profile"
# Optional for workstation/personal-workstation; required for personal-devbox/devbox/assistant/service:
./scripts/secrets/configure-sops-age-identity.sh
./scripts/bootstrap/configure-power.sh --profile "$profile"
./scripts/bootstrap/configure-spotlight.sh
./dotfiles check "$profile"
```

Use the target Unix user's `personal-devbox`, `devbox`, `assistant`, or
`service` role instead when appropriate, and keep the age-identity step for
those profiles.

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
- If historical prefix-owner content is unreadable to another devbox identity,
  run `brew-devbox.sh --repair-shared-readability` as the prefix owner, then
  retry verification. The repair is additive and owner-scoped; investigate
  files owned by another identity separately.
- If `chezmoi` is missing, rerun `./scripts/bootstrap/brew-bundle.sh` for the
  correct profile before `./dotfiles apply <profile>`.
- If Git reports dubious ownership under `/opt/homebrew`, rerun
  `configure-git.sh` for the correct profile.
- If `git@github.com` fails on a devbox profile but the key is present, rerun
  `configure-git.sh --profile devbox --non-interactive` (or use
  `personal-devbox`) with
  `GIT_SIGNING_KEY` or `GIT_SSH_IDENTITY_FILE` pointing at the owner-only local
  private key file.
- If shared env access is missing over SSH, check the SOPS recipient and
  deployment identity in [Devbox setup](devbox.md) instead of exporting service
  tokens in shell startup.
- If `codex` is not installed yet for a developer-profile user,
  `install.sh` skips Codex defaults; rerun it after installing the developer
  Homebrew layer.
- If macOS Gatekeeper blocks an embedded Cursor Agent `.node` module, remove a
  Homebrew `cursor-cli` cask installation and run
  `./scripts/bootstrap/install-cursor-agent.sh`. The repo intentionally uses
  Cursor's official per-user installer instead of recursively removing
  quarantine attributes from a Homebrew cask.
