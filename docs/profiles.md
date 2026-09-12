# User Profiles

Profiles configure one Unix user; host permissions provide isolation.

## Choose a Profile

| Profile | Role | Homebrew layers after [Brewfile](../Brewfile) |
| --- | --- | --- |
| `developer` | Default: runtimes, coding agents, rules, and skills for any Unix user | none |
| `devbox` | `developer` on a human-operated SSH coding host | [Devbox](../Brewfile.devbox) |
| `workstation` | `developer` on a human laptop or desktop | [Workstation](../Brewfile.workstation) |
| `personal-devbox` | `devbox` plus personal headless tools and skills | [Devbox](../Brewfile.devbox), [personal](../Brewfile.personal) |
| `personal-workstation` | `workstation` plus personal desktop apps and tools | [Workstation](../Brewfile.workstation), [personal](../Brewfile.personal) |

- `./dotfiles diff|apply|check` without a profile uses the stored
  `~/.config/dotfiles/profile`, or `developer` on a fresh user.
- [profiles.json](../chezmoi/.chezmoidata/profiles.json) owns capabilities,
  [skill layers](agents.md), and install steps. Brewfiles own packages.
- macOS-only scripts live under `scripts/darwin/`; everything else in
  `scripts/` is shared.
- Every profile installs [oh-my-zsh](https://ohmyzsh.sh) with the
  `robbyrussell` theme and `git` plugin; `./dotfiles maintain` updates it and
  its own updater stays disabled. `devbox` profiles replace the prompt with
  `➜ user@host ~ git:(branch)` so SSH sessions name the machine.
- Command-line tools with binary releases (`age`, `sops`, `gh`, `jq`,
  `ripgrep`, `shellcheck`, `actionlint`, `chezmoi`, `direnv`, `gitleaks`,
  `trufflehog`, `topgrade`, OpenCode, `awscli`, `glab`, `git-filter-repo`,
  Codex, Claude Code, and on macOS `xcodes` and `xcodegen`) are mise tools
  pinned in [mise.toml](../chezmoi/.chezmoitemplates/mise.toml), so both
  platforms share one pin and Renovate. Homebrew keeps what needs a compiler,
  a GUI, or a system service: `git`, `mise`, `tmux`, `btop`, `ffmpeg`,
  `watchman`, `git-crypt`, the Docker and Colima stack, `lynis`, `mole`, and
  the casks. A Mac upgraded from the Homebrew copies keeps them until
  `./scripts/darwin/bootstrap/brew-bundle.ts --cleanup <profile>` runs; the
  shell fronts the mise shims, so the leftovers are inert meanwhile.
- Personal GUI casks and `mas` install only for `personal-workstation`.
- The selected role is stored in `~/.config/dotfiles/profile` and checked during
  verification.

## Host and User Boundaries

- An authorized administrator owns host-wide Homebrew, Tailscale, power,
  Spotlight, and LaunchDaemon changes.
- Shared devbox Homebrew is owner-write, consumer-read-only. Other users check
  package presence; they do not update the prefix.
- Use Unix ownership, groups, filesystem permissions, and scoped identities for
  isolation. Shared package visibility does not provide it.
- Unattended runtime packages and machine credentials belong to the hosting
  configuration. Profiles here enroll human-operated macOS users.
- [Identity provisioning](identities.md) owns authorship, signing, SSH, age, and
  recovery. Identity values remain untracked operator input.

## Apply a Profile

Choose one role; run Homebrew setup as its authorized administrator:

```zsh
profile=workstation
./scripts/darwin/bootstrap/brew-bundle.ts "$profile"
```

As the target Unix user:

```zsh
mise trust
./dotfiles diff "$profile"
./dotfiles apply "$profile"
./scripts/bootstrap/configure-git.ts --profile "$profile"
```

All profiles except `workstation` require an age identity before verification.
For `workstation`, enroll one when SOPS decryption is needed:

```zsh
./scripts/secrets/configure-sops-age-identity.ts
./dotfiles check "$profile"
```

## Local Homebrew Additions

Machine-specific packages that no shared profile should carry go in an optional
`Brewfile.local` at the checkout root:

- The file is gitignored and belongs to the checkout owner. It must be a regular
  file owned by the current user without group/other write access; a symlink,
  directory, or writable file fails setup and verification.
- Contents are trusted Homebrew Bundle Ruby, evaluated after the selected
  profile's layers with the same `HOMEBREW_BUNDLE_DOTFILES_PROFILE`. Ruby
  errors surface from `brew bundle`.
- Setup, `--maintenance`, live verification, and `--cleanup` include it;
  `--shared-only` does not. Cleanup keeps local packages and their dependencies
  alongside the profile contract; shared devboxes still use the personal-devbox
  union.
- A missing file changes nothing. `DOTFILES_BREWFILE_LOCAL` overrides the path
  for fixtures.

Use it for packages Homebrew installs. Applications supplied by another
installer belong in the external capability file below, which accepts names
declared here.

## Externally Managed Homebrew Capabilities

Profiles can accept packages supplied by another trusted installer:

- Create `~/.config/dotfiles/external-homebrew.plist`: a regular XML plist,
  owned by the user, without group/other write access.
- Use version `1` and a `capabilities` array following the
  [schema](../scripts/darwin/lib/homebrew.ts) and
  [examples](../scripts/darwin/verify/external-homebrew.ts). Entries must name packages
  declared in the selected profile's Brewfiles, `Brewfile.local`, or
  `externalHomebrew` list.
- `command`: absolute executable owned by root or the user, without group/other
  write access; up to three literal arguments for a safe execution probe.
- `bundle`: absolute nonsymlinked app bundle, exact bundle identifier and signing
  team, and valid strict signature.
- Unknown/duplicate entries, failed probes, unsafe permissions, and signature
  mismatches fail setup. Ambient Homebrew Bundle skip variables are rejected.

Only personal profiles install `uinaf/tap` and its `slopguard` cask. On
`workstation` and `devbox`, supply `slopguard` through an authorized installer;
live verification still requires `slopguard version` to pass. Its cask name is
accepted in the external capability file without trusting or installing the
personal tap.
