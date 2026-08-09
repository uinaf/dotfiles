# User Profiles

Profiles describe the role of one Unix user. They do not describe the whole
host and they are not a security boundary by themselves.

## Roles

| Profile | Intended user | Default capability |
| --- | --- | --- |
| `workstation` | Interactive human on a laptop or desktop | Portable development, human authentication, and local containers |
| `personal` | Owner-operated personal laptop or desktop | Workstation capabilities plus opinionated applications and preferences |
| `personal-devbox` | Owner-operated remote coding identity | Devbox capabilities plus personal agent skills, without personal desktop software |
| `devbox` | Remote coding identity on an SSH-first host | Coding agents, Git/GitHub, SDKs, containers, and verification tools |
| `assistant` | Unattended persona or agent identity | Minimal agent runtime, browser, and scoped GitHub App access |
| `service` | Non-persona managed workload identity | Identity-safe bootstrap tools; workload-owned runtime, authentication, and supervision |

Choose `workstation` when another trusted system may supply or govern software.
Choose `personal` only when this repository should own the full personal
desktop contract. Choose `personal-devbox` for an owner-operated headless
devbox that should receive personal agent skills. Its `personal` prefix does
not include the workstation or personal desktop layers.

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

All profiles install the minimal `Brewfile` base. Personal, personal-devbox,
workstation, and devbox also install `Brewfile.developer`. Workstation installs
`Brewfile.workstation`; devbox and personal-devbox install `Brewfile.devbox`.
Personal installs `Brewfile.workstation` followed by `Brewfile.personal`.
Assistant skips the developer layer and installs only `Brewfile.assistant`.
Service installs only the base and `Brewfile.service`.

The assistant mise config contains only Node, and its profile layer adds Chrome
and `gh`. The service profile declares neither browser nor language runtime.
Workload repositories own OpenClaw, Hermes, model providers, media tools,
containers, process supervision, language runtimes, and other
workload-specific packages.

Personal, personal-devbox, workstation, and devbox retain the full shared
development runtime set, including Codex CLI, Claude Code CLI, Cursor Agent
CLI, and 1Password CLI.
The same developer layer installs the attach, autoreview, and slopomatic CLIs
from `uinaf/tap`. Their install flow also syncs machine-global instructions
and additive skills from `scripts/agents/`; see
[Agent setup](agents.md). Zed and its managed settings belong only to personal.
The workstation layer supplies 1Password, Slack, Claude Desktop, and ChatGPT to
both interactive profiles. The separately verified Cursor desktop installer is
available to either interactive profile.

Assistant dotfile application installs a minimal Git base and the
`gh-app-auth` execution adapter. Service dotfile application installs only the
minimal Git base. Both omit developer signing, human credential helpers,
outbound SSH defaults, desktop settings, global coding-agent instructions, and
development skills. Service authentication remains entirely workload-owned.

## Identity Policy

[Identity provisioning](identities.md) is the source of truth for age, Git,
SSH, GitHub App, recovery, and deployment lifecycle. Workstation, devbox, and
personal-devbox users configure explicit human authorship and local signing.
Assistants configure unsigned workload authorship and use a workload-owned
GitHub App for repository access. Services configure unsigned workload
authorship but receive authentication only from their owning workload.
Identity values remain operator input and are never tracked.

## Apply a Profile

Run Homebrew changes from the authorized host administrator:

```zsh
./scripts/bootstrap/brew-bundle.sh personal
./scripts/bootstrap/brew-bundle.sh personal-devbox
./scripts/bootstrap/brew-bundle.sh workstation
./scripts/bootstrap/brew-bundle.sh devbox
./scripts/bootstrap/brew-bundle.sh assistant
./scripts/bootstrap/brew-bundle.sh service
```

Then run the per-user setup as the target Unix user:

```zsh
profile=workstation
./scripts/bootstrap/apply-dotfiles.sh --profile "$profile"
mise trust
mise install
./scripts/bootstrap/install.sh --profile "$profile"
# Optional until this machine decrypts vault or other SOPS material:
# ./scripts/secrets/configure-sops-age-identity.sh
./scripts/verify/bootstrap.sh --profile "$profile"
```

Use `profile=personal` for the opinionated personal desktop layer or
`profile=personal-devbox` for devbox packages plus personal skills. The
remaining steps are identical. Secret-consuming profiles (`personal-devbox`,
`devbox`, `assistant`, `service`) still require the age-identity step before
bootstrap verification.

Configure the appropriate human or workload Git identity separately:

```zsh
./scripts/bootstrap/configure-git.sh --profile workstation
./scripts/bootstrap/configure-git.sh --profile personal
./scripts/bootstrap/configure-git.sh --profile personal-devbox
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
GIT_USER_NAME='Service Name' \
GIT_USER_EMAIL='service@example.invalid' \
  ./scripts/bootstrap/configure-git.sh --profile service --non-interactive
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

The `command` validator requires an absolute executable path owned by the
current user or root and not writable by group or other users. It runs up to
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

To convert an owner-operated devbox, apply `personal-devbox` through the
Homebrew, dotfile, install, Git, and verification commands above. This changes
the persisted marker and personal skill selection while retaining the devbox
package, identity, service, power, and audit contracts.
