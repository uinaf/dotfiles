# User Profiles

Profiles describe the role of one Unix user. They do not describe the whole
host and they are not a security boundary by themselves.

## Roles

| Profile | Intended user | Default capability |
| --- | --- | --- |
| `workstation` | Interactive human on a laptop or desktop | Portable development, human authentication, and local containers |
| `personal-workstation` | Owner-operated personal laptop or desktop | Workstation capabilities plus personal applications, tools, skills, and preferences |
| `personal-devbox` | Owner-operated remote coding identity | Devbox capabilities plus headless personal tools, skills, and preferences |
| `devbox` | Remote coding identity on an SSH-first host | Coding agents, Git/GitHub, SDKs, containers, and verification tools |
| `assistant` | Unattended persona or agent identity | Minimal agent runtime, browser, and scoped GitHub App access |
| `service` | Non-persona managed workload identity | Identity-safe bootstrap tools; workload-owned runtime, authentication, and supervision |

Choose `workstation` when another trusted system may supply or govern software.
Choose `personal-workstation` when this repository should own the full personal
workstation contract. Choose `personal-devbox` for an owner-operated devbox
that should receive the additive personal formulas and skills without GUI casks.

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

[`chezmoi/.chezmoidata/profiles.json`](../chezmoi/.chezmoidata/profiles.json)
is the versioned source of truth for profile capabilities, Brewfile order,
runtime groups, skill layers, and per-user install steps. Chezmoi reads it as
template data, TypeScript uses the strict parser in `scripts/profiles/model.ts`,
and shell reads typed values through the small `plutil` boundary in
`scripts/lib/profile.sh`. These consumers reject unsupported versions, unknown
profiles, missing fields, and wrong value types. No generated profile adapters
exist.

All profiles install the shared `Brewfile` base, including Chrome and `gh`.
Personal-workstation, personal-devbox, workstation, and devbox also install
`Brewfile.developer`. Workstation installs
`Brewfile.workstation`; devbox and personal-devbox install `Brewfile.devbox`.
Both personal profiles finish with `Brewfile.personal`; its profile-aware
declarations install GUI casks only for personal-workstation.
Assistant skips the developer layer and installs only `Brewfile.assistant`.
Service installs only the base and `Brewfile.service`.

The assistant mise config contains only Node. Its profile layer adds portable
document, media, Google, and macOS automation tools. Workload repositories own
OpenClaw, Hermes, model providers, containers, process supervision, language
runtimes, and other framework-specific packages. The service profile declares
no additional Homebrew software or language runtime.

Personal-workstation, personal-devbox, workstation, and devbox retain the full shared
development runtime set, including Codex CLI, Claude Code CLI, Cursor Agent
CLI, and 1Password CLI.
The developer layer installs the autoreview and slopshipper CLIs. The personal
layer installs the App Store Connect CLI, Attach, Crabbox, Gitcrawl, and Mole for both personal profiles,
while personal GUI applications remain workstation-only. Developer-profile install
flows apply machine-global instructions through chezmoi and sync additive skills
from `scripts/agents/`; see [Agent setup](agents.md). Zed and its managed settings
belong only to personal-workstation.
The workstation layer supplies 1Password, Slack, ChatGPT, Cursor, and Ghostty
desktop apps, plus YubiKey Manager, to both interactive profiles. Claude Code
is CLI-only and comes from the shared developer layer. The
personal-workstation-only branch also installs `mas` for App Store automation.
Watchman belongs to the shared developer layer.

Assistant dotfile application installs the shared Git base and the
`gh-app-auth` execution adapter. Service dotfile application installs only the
shared Git base. Both omit developer signing, human credential helpers,
outbound SSH defaults, desktop settings, global coding-agent instructions, and
development skills. Service authentication remains entirely workload-owned.

## Identity Policy

[Identity provisioning](identities.md) is the source of truth for age, Git,
SSH, GitHub App, recovery, and deployment lifecycle. Workstation,
personal-workstation, personal-devbox, and devbox users configure explicit
human authorship and local signing.
Assistants configure unsigned workload authorship and use a workload-owned
GitHub App for repository access. Services configure unsigned workload
authorship but receive authentication only from their owning workload.
Identity values remain operator input and are never tracked.

## Apply a Profile

Run Homebrew changes from the authorized host administrator:

```zsh
./scripts/bootstrap/brew-bundle.sh personal-workstation
./scripts/bootstrap/brew-bundle.sh personal-devbox
./scripts/bootstrap/brew-bundle.sh workstation
./scripts/bootstrap/brew-bundle.sh devbox
./scripts/bootstrap/brew-bundle.sh assistant
./scripts/bootstrap/brew-bundle.sh service
```

Then run the per-user setup as the target Unix user:

```zsh
profile=workstation
mise trust
./dotfiles diff "$profile"
./dotfiles apply "$profile"
# Optional until this machine decrypts vault or other SOPS material:
# ./scripts/secrets/configure-sops-age-identity.sh
./dotfiles check "$profile"
```

Use `profile=personal-workstation` for the personal workstation composition or
`profile=personal-devbox` for the personal devbox composition. The
remaining steps are identical. Secret-consuming profiles (`personal-devbox`,
`devbox`, `assistant`, `service`) still require the age-identity step before
bootstrap verification.

Configure the appropriate human or workload Git identity separately:

```zsh
./scripts/bootstrap/configure-git.sh --profile workstation
./scripts/bootstrap/configure-git.sh --profile personal-workstation
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
`~/.config/dotfiles/external-homebrew.plist` as a regular XML property list owned by the current
user and not writable by group or other users.

The root dictionary has version `1` and a `capabilities` array. Each capability
names a selected-profile entry and either a command or app-bundle validator:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>version</key>
  <integer>1</integer>
  <key>capabilities</key>
  <array>
    <dict>
      <key>packageType</key><string>brew</string>
      <key>name</key><string>git</string>
      <key>validator</key><string>command</string>
      <key>path</key><string>/usr/bin/git</string>
      <key>arguments</key>
      <array><string>--version</string></array>
    </dict>
    <dict>
      <key>packageType</key><string>cask</string>
      <key>name</key><string>google-chrome</string>
      <key>validator</key><string>bundle</string>
      <key>path</key><string>/Applications/Google Chrome.app</string>
      <key>bundleIdentifier</key><string>com.google.Chrome</string>
      <key>teamIdentifier</key><string>TEAM_IDENTIFIER</string>
    </dict>
  </array>
</dict>
</plist>
```

The `command` validator requires an absolute executable path owned by the
current user or root and not writable by group or other users. It runs up to
three literal arguments. Use it when a safe version or health probe can prove
that endpoint policy permits execution. The `bundle` validator requires an
absolute nonsymlinked app bundle, exact bundle identifier, exact signing team,
and a valid strict code signature.

Both `brew-bundle.sh` and bootstrap verification reject ambient Homebrew Bundle
skip variables. They use macOS `plutil` to lint the file and enforce root,
version, record, field, and value types before setting a formula or cask skip
list. Unknown entries, duplicates, failed commands, signature mismatches,
unsafe permissions, and unreadable files fail closed. Delimiters, whitespace,
and Unicode are normal plist string content.
