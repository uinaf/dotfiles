# Bootstrap Guide

Run commands from the repository root as the target Unix user. Choose a
[profile](profiles.md): `workstation`, `personal-workstation`, `devbox`, or
`personal-devbox`.

## First-Time Prerequisites

Install Apple Command Line Tools and Homebrew:

```zsh
xcode-select --install
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Install the clone tools, authenticate, and prepare the checkout:

```zsh
brew install git gh mise
gh auth login
mkdir -p ~/projects
gh repo clone uinaf/dotfiles ~/projects/dotfiles
cd ~/projects/dotfiles
./dotfiles prepare
export PATH="$(mise --no-config where node@"$(cat .node-version)")/bin:$PATH"
```

On a shared devbox, run the initial `brew install` as the prefix owner inside
`(umask 0027; brew install git gh mise)`. Use the [shared wrapper](#shared-homebrew-updates)
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
profile=workstation # or personal-workstation, devbox, personal-devbox
./scripts/bootstrap/brew-bundle.ts "$profile"
mise trust
./dotfiles diff "$profile"
./dotfiles apply "$profile"
./scripts/bootstrap/configure-git.ts --profile "$profile"
```

- Configure [Git authorship and local SSH keys](identities.md#developer-git-and-ssh)
  from explicit operator values.
- Every profile except `workstation` requires a
  [backed-up SOPS age identity](identities.md#sops-age-identity).
  `workstation` needs one when it consumes secrets.
- For externally supplied Homebrew packages or refused tap trust, configure
  [external capabilities](profiles.md#externally-managed-homebrew-capabilities).

Run these host-wide steps once from the administrator account:

```zsh
./scripts/bootstrap/configure-power.ts --profile "$profile"
./scripts/bootstrap/configure-spotlight.ts
```

Power configuration disables sleep while plugged in and leaves battery settings
unchanged. Spotlight configuration disables indexing on mounted volumes without
removing existing index data.

### Workstation Options

- Install licensed Berkeley Mono Variable manually; Ghostty falls back to Menlo.
- On `personal-workstation`, run `./scripts/app-store/personal.ts` to remove
  the unused bundled App Store apps; uninstall may prompt for a password.
- Quit Chrome before running `./scripts/bootstrap/configure-chrome.ts` to apply
  Lens policies and the vertical-tabs setting.
- For simulators, SDKs, and signing certificates, follow
  [Mobile and TV development](mobile-and-tv-development.md).

### Devbox Options

Follow [Devbox setup](devbox.md) for services and secret consumers. The logged-in
owner may apply the optional desktop baseline:

```zsh
./scripts/bootstrap/configure-desktop.ts
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
./scripts/verify/devbox-services.ts
mise run audit devbox
```

## Shared Homebrew Updates

The prefix owner must use the wrapper for shared-devbox mutations:

```zsh
./scripts/bootstrap/brew-devbox.ts upgrade
./scripts/bootstrap/brew-devbox.ts upgrade --cask
./scripts/bootstrap/brew-devbox.ts --update-software
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
./scripts/bootstrap/brew-bundle.ts "$profile"
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
| Missing packages or `chezmoi` | Rerun `brew-bundle.ts` with the selected profile. |
| Homebrew drift | Review and run `./scripts/bootstrap/brew-bundle.ts --cleanup <profile>`. This removes undeclared packages; shared devboxes use the personal-devbox package union. |
| Shared prefix permissions | Run `./scripts/bootstrap/brew-devbox.ts --repair-shared-readability` as the prefix owner. Foreign-owned content needs an administrator to correct ownership. |
| Git dubious ownership under `/opt/homebrew` | Rerun `configure-git.ts` with the selected profile. |
| GitHub SSH authentication | Check the local key and rerun [Git configuration](identities.md#developer-git-and-ssh). |
| Secret access over SSH | Check the deployment recipient and encrypted repository policy in [Identity provisioning](identities.md). |
| Gatekeeper blocks a Cursor Agent `.node` module | Remove the Homebrew `cursor-cli` cask and run `./scripts/bootstrap/install-cursor-agent.ts` for the per-user vendor installation. |
