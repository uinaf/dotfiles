# Bootstrap Guide

Run commands from the repository root as the target Unix user. Choose a
[profile](profiles.md): `developer`, `devbox`, `workstation`,
`personal-devbox`, or `personal-workstation`.

## First-Time Prerequisites

### Linux (Ubuntu)

The host owns root-level packages: `git`, `curl`, `zsh`, `tmux`, `mise` on
the system PATH, and the login shell set to `zsh`. A managed devbox gets those
from its provisioning; elsewhere:

```sh
sudo apt-get install -y git curl zsh tmux lynis age
# sops has no Ubuntu package; the host installs the release binary for its
# architecture on the fixed path the sudo askpass helper resolves. A managed
# devbox gets this from its provisioning, which owns the version pin.
sops_version=3.13.3
sudo curl -fsSLo /usr/local/bin/sops "https://github.com/getsops/sops/releases/download/v${sops_version}/sops-v${sops_version}.linux.$(dpkg --print-architecture)"
sudo chmod 0755 /usr/local/bin/sops
curl https://mise.run | sh   # installs ~/.local/bin/mise
export PATH="$HOME/.local/bin:$PATH"
sudo chsh -s /usr/bin/zsh "$USER"
mkdir -p ~/projects
git clone https://github.com/uinaf/dotfiles.git ~/projects/dotfiles
cd ~/projects/dotfiles
./dotfiles prepare
```

Skip the Homebrew steps below; `gh auth login` comes after the first apply
installs `gh`. `workstation` profiles are macOS-only; use `developer` or
`devbox` here.

The `devbox` profile also expects two host-provided prerequisites, both
probed by `./dotfiles check devbox`:

- Tailscale installed and joined.
- systemd lingering for the user: `sudo loginctl enable-linger <user>`.

Every other tool comes from the profile's mise configuration: `gh`, `jq`,
`ripgrep`, `shellcheck`, `actionlint`, `chezmoi`, `direnv`, `btop`,
`gitleaks`, `trufflehog`, `topgrade`, OpenCode, `awscli`, `glab`,
`git-filter-repo`, Codex, Claude Code, and the T3 CLI. Cursor uses its own
installer. `age` and `sops` stay host packages on both platforms because the
sudo askpass helper calls them by fixed path.
Android SDK and emulator tooling stay a per-user install; set `ANDROID_HOME`
to `~/Android/Sdk` and the shell picks it up.

### macOS

Install Apple Command Line Tools and Homebrew:

```zsh
xcode-select --install
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Install the clone tools and prepare the checkout; `gh auth login` follows the
first apply, which installs `gh` through mise:

```zsh
brew install git mise
mkdir -p ~/projects
git clone https://github.com/uinaf/dotfiles.git ~/projects/dotfiles
cd ~/projects/dotfiles
./dotfiles prepare
export PATH="$(mise --no-config where node@"$(cat .node-version)")/bin:$PATH"
```

On a shared devbox, run the initial `brew install` as the prefix owner inside
`(umask 0027; brew install git mise)`. Use the [shared wrapper](#shared-homebrew-updates)
for subsequent mutations.

`prepare` installs the pinned Node runtime and locked repository dependencies.

### Gitless First Fetch

If Git is unavailable, fetch an archive to inspect and bootstrap:

```zsh
mkdir -p ~/projects
curl -fL https://github.com/uinaf/dotfiles/archive/refs/heads/main.zip \
  -o /tmp/dotfiles-main.zip
ditto -x -k /tmp/dotfiles-main.zip ~/projects
mv ~/projects/dotfiles-main ~/projects/dotfiles
cd ~/projects/dotfiles
```

Install Homebrew and mise, then run `prepare` and the Node `PATH` export above.
Once Git and `gh` work, move the archive aside and clone into a fresh directory
before using Git updates or contribution commands.

## Apply a Profile

Before applying a personal profile, provision the owner-only
[LLM gateway config](devbox.md#opt-in-coding-llm-gateway). Personal setup retires
saved coding-client logins except those listed in `preservedLogins`.

```zsh
profile=workstation # or developer, devbox, personal-devbox, personal-workstation
./scripts/darwin/bootstrap/brew-bundle.ts "$profile" # macOS only
mise trust
./dotfiles diff "$profile"
./dotfiles apply "$profile"
./scripts/bootstrap/configure-git.ts --profile "$profile"
```

- Configure [Git authorship and local SSH keys](identities.md#developer-git-and-ssh)
  from explicit operator values.
- Install [the pinned Xcode](mobile-and-tv-development.md) with
  `mise run xcode:install`.
- Every profile except `workstation` requires a
  [backed-up SOPS age identity](identities.md#sops-age-identity).
  `workstation` needs one when it consumes secrets.
- For machine-specific Homebrew packages, add a gitignored
  [local Brewfile](profiles.md#local-homebrew-additions).
- For externally supplied Homebrew packages or refused tap trust, configure
  [external capabilities](profiles.md#externally-managed-homebrew-capabilities).

Run these host-wide steps once from the administrator account:

```zsh
./scripts/darwin/bootstrap/configure-power.ts --profile "$profile"
./scripts/darwin/bootstrap/configure-spotlight.ts
```

Power configuration disables sleep while plugged in and leaves battery settings
unchanged. Spotlight configuration disables indexing on mounted volumes without
removing existing index data.

### Spotlight Policy

Developer profile checks require Spotlight indexing to be disabled by default.
If indexing is intentional, omit the `configure-spotlight.ts` setup step and
skip its verification with:

```zsh
DOTFILES_SKIP_SPOTLIGHT_CHECK=1 ./dotfiles check "$profile"
```

For subsequent checks, export `DOTFILES_SKIP_SPOTLIGHT_CHECK=1` in your
machine-local [`~/.config/dotfiles/zshenv.local`](chezmoi.md#local-overrides).
Checks report the policy as skipped and leave indexing unchanged. `apply` does
not configure Spotlight. An explicit
`./scripts/darwin/bootstrap/configure-spotlight.ts` still disables indexing and verifies
the result, even with this flag set.

### Workstation Options

- Install licensed Berkeley Mono Variable manually; Ghostty falls back to Menlo.
- On `personal-workstation`, run `./scripts/darwin/app-store/personal.ts` to remove
  the unused bundled App Store apps; uninstall may prompt for a password.
- Quit Chrome before running `./scripts/darwin/bootstrap/configure-chrome.ts` to apply
  Lens policies and the vertical-tabs setting.
- For simulators, SDKs, and signing certificates, follow
  [Mobile and TV development](mobile-and-tv-development.md).

### Devbox Options

Follow [Devbox setup](devbox.md) for services and secret consumers. The logged-in
owner may apply the optional desktop baseline:

```zsh
./scripts/darwin/bootstrap/configure-desktop.ts
./scripts/verify/bootstrap.ts --profile devbox --desktop
```

### Verify

Run as each intended Unix user:

```zsh
mise run maintenance:check
./dotfiles check "$profile"
mise run audit host
```

For workstations, also run `mise run audit workstation`. For devbox profiles:

```zsh
./scripts/darwin/verify/devbox-services.ts
mise run audit devbox
```

## Shared Homebrew Updates

The prefix owner must use the wrapper for shared-devbox mutations:

```zsh
./scripts/darwin/bootstrap/brew-devbox.ts upgrade
./scripts/darwin/bootstrap/brew-devbox.ts upgrade --cask
./scripts/darwin/bootstrap/brew-devbox.ts --update-software
```

It confines the owner-write/group-read umask to Homebrew, repairs owner-owned
content after attempted mutations, and refuses foreign-owned or group-writable
prefix content. The devbox bundle command uses it internally.

Enroll [headless updates](software-updates.md#headless-devbox-updates) for
scheduled execution without a GUI session.

## Updating an Existing Machine

Refresh the checkout, review the selected profile, then converge it:

```zsh
cd ~/projects/dotfiles
git pull --ff-only
profile=workstation # select the installed profile
./scripts/darwin/bootstrap/brew-bundle.ts "$profile"
mise trust
./dotfiles diff "$profile"
./dotfiles apply "$profile"
./dotfiles check "$profile"
```

Personal `apply` also retires unpreserved coding-client logins. Unattended
[convergence](software-updates.md#dotfiles-convergence) uses `./dotfiles maintain`,
which preserves saved logins. For package-only refreshes, use
[Software updates](software-updates.md).

## Troubleshooting

| Failure | Recovery |
| --- | --- |
| Missing Homebrew packages | Rerun `brew-bundle.ts` with the selected profile. |
| Missing `chezmoi` or another mise tool | Rerun `./dotfiles apply`; the first apply borrows the pinned `chezmoi` through `mise x` and `install-runtimes` installs the rest. |
| Homebrew drift | Keep intentional machine-specific packages in a [local Brewfile](profiles.md#local-homebrew-additions), then review and run `./scripts/darwin/bootstrap/brew-bundle.ts --cleanup <profile>`. This removes undeclared packages; shared devboxes use the personal-devbox package union. |
| Shared prefix permissions | Run `./scripts/darwin/bootstrap/brew-devbox.ts --repair-shared-readability` as the prefix owner. Foreign-owned content needs an administrator to correct ownership. |
| Git dubious ownership under `/opt/homebrew` | Rerun `configure-git.ts` with the selected profile. |
| GitHub SSH authentication | Check the local key and rerun [Git configuration](identities.md#developer-git-and-ssh). |
| Secret access over SSH | Check the deployment recipient and encrypted repository policy in [Identity provisioning](identities.md). |
| Gatekeeper blocks a Cursor Agent `.node` module | Remove the Homebrew `cursor-cli` cask and run `./scripts/bootstrap/install-cursor-agent.ts` for the per-user vendor installation. |
