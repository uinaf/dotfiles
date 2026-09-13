# User Profiles

Profiles configure one Unix user; host permissions provide isolation.

## Choose a Profile

| Profile | Role |
| --- | --- |
| `developer` | Default: runtimes and coding agents for any Unix user |
| `devbox` | Human-operated SSH coding host |
| `workstation` | Human laptop or desktop |
| `personal-devbox` | Devbox with personal tools and gateway routing |
| `personal-workstation` | Workstation with personal apps and gateway routing |

- `./dotfiles diff|apply|check` without a profile uses the stored
  `~/.config/dotfiles/profile`, or `developer` on a fresh user.
- [profiles.json](../chezmoi/.chezmoidata/profiles.json) owns capabilities,
  Homebrew layers, agent selections, and install steps. The referenced
  Brewfiles own macOS packages; [mise templates](mise.md) own runtime and tool pins.
- `workstation` profiles configure a macOS desktop; `./dotfiles apply` refuses
  them on Linux. `developer` and the `devbox` profiles run on both.

## Host and User Boundaries

- An authorized administrator owns host-wide Homebrew, Tailscale, power,
  Spotlight, LaunchDaemon, and systemd lingering changes.
- Shared devbox Homebrew is owner-write, consumer-read-only. Other users check
  package presence; they do not update the prefix.
- Use Unix ownership, groups, filesystem permissions, and scoped identities for
  isolation. Shared package visibility does not provide it.
- Unattended runtime packages, machine credentials, and Linux host packages
  belong to the hosting configuration. Profiles here enroll human-operated
  users and own everything inside their home directories.
- [Identity provisioning](identities.md) owns authorship, signing, SSH, age, and
  recovery. Identity values remain untracked operator input.

## Apply a Profile

Follow [Bootstrap](bootstrap.md#apply-a-profile), including its gateway and
identity prerequisites. Personal apply retires unpreserved coding-client logins.

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
  [schema](../homebrew/homebrew.ts) and
  [examples](../homebrew/verify/external-homebrew.ts). Entries must name packages
  declared in the selected profile's Brewfiles, `Brewfile.local`, or
  `externalHomebrew` list.
- `command`: absolute executable owned by root or the user, without group/other
  write access; up to three literal arguments for a safe execution probe.
- `bundle`: absolute nonsymlinked app bundle, exact bundle identifier and signing
  team, and valid strict signature.
- Unknown/duplicate entries, failed probes, unsafe permissions, and signature
  mismatches fail setup. Ambient Homebrew Bundle skip variables are rejected.

Only personal profiles install `uinaf/tap` and its `slopguard` cask. On
`developer`, `workstation`, and `devbox`, supply `slopguard` through an
authorized installer; macOS live verification still requires `slopguard
version` to pass. Its cask name is accepted in the external capability file
without trusting or installing the personal tap.
