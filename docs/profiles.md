# User Profiles

Profiles describe the role of one Unix user. They do not describe the whole
host and they are not a security boundary by themselves.

## Roles

| Profile | Intended user | Default capability |
| --- | --- | --- |
| `workstation` | Interactive human on a laptop or desktop | Portable development, human authentication, and local containers |
| `personal` | Owner-operated personal laptop or desktop | Workstation capabilities plus opinionated applications and preferences |
| `devbox` | Remote coding identity on an SSH-first host | Coding agents, Git/GitHub, SDKs, containers, and verification tools |
| `assistant` | Unattended assistant or platform-service identity | Minimal runtimes, machine authentication, supervision, browser, and media support |

Choose `workstation` when another trusted system may supply or govern software.
Choose `personal` only when this repository should own the full personal
desktop contract.

## Host and User Boundaries

Homebrew, Tailscale, power policy, Spotlight, and system LaunchDaemons can be
host-wide on macOS. Run those changes once from an authorized host
administrator. Applying a per-user profile must not imply that the user owns or
may mutate every host-wide dependency.

The role is stored in `~/.config/dotfiles/profile`. Per-user verification checks
that the selected role matches this marker.

Shared software visibility is not isolation. Enforce isolation with Unix
ownership and groups, scoped machine identities, filesystem permissions, and
service configuration.

## Software Layers

All profiles install the minimal `Brewfile` base. Personal, workstation, and
devbox also install `Brewfile.developer`. Workstation and devbox then install
their profile layer. Personal installs `Brewfile.workstation` followed by
`Brewfile.personal`. Assistant skips the developer layer and installs only
`Brewfile.assistant`.

The assistant mise config contains only Node. Workload repositories own
OpenClaw, Hermes, model providers, additional language runtimes, and other
workload-specific packages. Personal, workstation, and devbox retain the full
shared development runtime set, including Cursor Agent CLI. Workstation and
personal install Codex CLI and Claude Code CLI in the workstation layer; devbox
installs them in its own layer. Their install flow also syncs machine-global
instructions and additive skills from `scripts/agents/`; see
[Agent setup](agents.md). Zed and its managed settings belong only to personal.
The separately verified Cursor desktop installer is available to either
interactive profile.

Assistant dotfile application installs a minimal Git base and the
`gh-app-auth` execution adapter. It leaves App credentials unconfigured and
omits developer signing, human credential helpers, outbound SSH defaults,
desktop settings, global coding-agent instructions, and development skills.

## Identity Policy

[Identity provisioning](identities.md) is the source of truth for age, Git,
SSH, GitHub App, recovery, and deployment lifecycle. Workstation and devbox
users configure explicit human authorship and local signing. Assistants
configure unsigned workload authorship and use a workload-owned GitHub App for
repository access. Identity values remain operator input and are never
tracked.

## Apply a Profile

Run Homebrew changes from the authorized host administrator:

```zsh
./scripts/bootstrap/brew-bundle.sh workstation
./scripts/bootstrap/brew-bundle.sh devbox
./scripts/bootstrap/brew-bundle.sh assistant
```

Then run the per-user setup as the target Unix user:

```zsh
profile=workstation
./scripts/bootstrap/apply-dotfiles.sh --profile "$profile"
mise trust
mise install
./scripts/bootstrap/install.sh --profile "$profile"
./scripts/secrets/configure-sops-age-identity.sh
./scripts/verify/bootstrap.sh --profile "$profile"
```

Use `profile=personal` for the opinionated personal layer. The remaining
steps are identical.

Configure the appropriate human or workload Git identity separately:

```zsh
./scripts/bootstrap/configure-git.sh --profile workstation
./scripts/bootstrap/configure-git.sh --profile personal
./scripts/bootstrap/configure-git.sh --profile devbox
GIT_USER_NAME='Workload Name' \
GIT_USER_EMAIL='APP_BOT_NOREPLY_EMAIL' \
  ./scripts/bootstrap/configure-git.sh --profile assistant --non-interactive
./scripts/bootstrap/configure-assistant-github-app.sh \
  --name example-app \
  --app-id APP_ID \
  --installation-id INSTALLATION_ID \
  --repo github.com/example/workspace \
  --repo github.com/example/vault
```

## Externally Managed Homebrew Capabilities

A workstation can accept a formula or cask from another trusted installer
without pretending Homebrew owns it. Create
`~/.config/dotfiles/external-homebrew` as a regular file owned by the current
user and not writable by group or other users.

Each non-comment line names an entry from the selected profile and its
validation contract:

```text
brew|git|command|/usr/bin/git|--version
cask|google-chrome|bundle|/Applications/Google Chrome.app|com.google.Chrome|TEAM_IDENTIFIER
```

The `command` validator requires an absolute executable path and runs up to
three literal arguments. Use it when a safe version or health probe can prove
that endpoint policy permits execution. The `bundle` validator requires an
absolute nonsymlinked app bundle, exact bundle identifier, exact signing team,
and a valid strict code signature.

Both `brew-bundle.sh` and bootstrap verification reject ambient Homebrew
Bundle skip variables, then validate this file before setting the formula or
cask skip list. Unknown entries, duplicates, failed commands, signature
mismatches, unsafe permissions, and unreadable files fail closed. Keep
organization-specific paths and identifiers in this local file, not in the
repository.

## Migrate an Existing User

For an installation that still uses the former owner-specific layout, follow
[Migrating to role profiles](migrating-to-role-profiles.md) before applying a
new role.

Before this profile split, invoking `personal` persisted `workstation`.
Existing personal machines that should retain the full opinionated layer must
run the package, dotfile, install, and verification steps again with
`profile=personal`. A managed or portable machine can keep
`profile=workstation`.
