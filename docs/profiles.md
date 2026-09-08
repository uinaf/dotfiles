# User Profiles

Profiles configure one Unix user; host permissions provide isolation.

## Choose a Profile

| Profile | Role | Homebrew layers after [Brewfile](../Brewfile) |
| --- | --- | --- |
| `workstation` | Human laptop or desktop | [Workstation](../Brewfile.workstation) |
| `personal-workstation` | Personal desktop apps and tools | [Workstation](../Brewfile.workstation), [personal](../Brewfile.personal) |
| `devbox` | Human-operated SSH coding identity | [Devbox](../Brewfile.devbox) |
| `personal-devbox` | Personal headless tools and skills | [Devbox](../Brewfile.devbox), [personal](../Brewfile.personal) |

- [profiles.json](../chezmoi/.chezmoidata/profiles.json) owns capabilities,
  runtimes, [skill layers](agents.md), and install steps. Brewfiles own packages.
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
./scripts/bootstrap/brew-bundle.ts "$profile"
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

## Externally Managed Homebrew Capabilities

Profiles can accept packages supplied by another trusted installer:

- Create `~/.config/dotfiles/external-homebrew.plist`: a regular XML plist,
  owned by the user, without group/other write access.
- Use version `1` and a `capabilities` array following the
  [schema](../scripts/lib/homebrew.ts) and
  [examples](../scripts/verify/external-homebrew.ts). Entries must name packages
  declared in the selected profile's Brewfiles or `externalHomebrew` list.
- `command`: absolute executable owned by root or the user, without group/other
  write access; up to three literal arguments for a safe execution probe.
- `bundle`: absolute nonsymlinked app bundle, exact bundle identifier and signing
  team, and valid strict signature.
- Unknown/duplicate entries, failed probes, unsafe permissions, and signature
  mismatches fail setup. Ambient Homebrew Bundle skip variables are rejected.

Only personal profiles install `uinaf/tap` and its `slopguard` and `slopmachine`
casks. On `workstation` and `devbox`, supply these commands through an authorized
installer; live verification still requires `slopguard version` and
`slopmachine version` to pass. Their cask names are accepted in the external
capability file without trusting or installing the personal tap.
