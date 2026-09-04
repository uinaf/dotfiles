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

> Unattended agent runtimes may be hosted outside this repository, in which case
> the hosting configuration owns their runtime, capability packages, and
> credential helper, and this profile has no consumer. Retiring it is then
> possible, but `scripts/bootstrap/configure-assistant-github-app.ts` and
> `scripts/bootstrap/install-gh-app-auth.ts` must survive: they are the only
> tooling that provisions an agent identity's GitHub App key and `config.yml`,
> and a remote host consumes those files rather than creating them.

- Choose `workstation` when another trusted system may supply or govern
  software.
- Choose `personal-workstation` when this repository should own the full personal
  workstation contract.
- Choose `personal-devbox` for an owner-operated devbox that should receive the
  additive personal formulas and skills without GUI casks.

## Host and User Boundaries

- Homebrew, Tailscale, power policy, Spotlight, and system LaunchDaemons can be
  host-wide on macOS. Run those changes once from an authorized host
  administrator.
- Applying a per-user profile must not imply that the user owns or may mutate
  every host-wide dependency.
- Shared devbox Homebrew is owner-write and consumer-read-only. Devbox shells
  disable implicit Homebrew auto-update, and bootstrap verification rejects
  foreign-owned or group-writable prefix content. Bootstrap verifies installed
  package presence without using per-user metadata for upgrade freshness;
  maintenance inventory owns freshness checks.
- The role is stored in `~/.config/dotfiles/profile`. Per-user verification
  checks that the selected role matches this marker.
- Shared software visibility is not isolation. Enforce isolation with Unix
  ownership and groups, scoped machine identities, filesystem permissions, and
  service configuration.

## Software Layers

[`chezmoi/.chezmoidata/profiles.json`](../chezmoi/.chezmoidata/profiles.json)
is the versioned source of truth for profile capabilities, Brewfile order,
runtime groups, skill layers, and per-user install steps. Three consumers read
it directly:

| Consumer | How it reads the file |
| --- | --- |
| Chezmoi | as template data |
| TypeScript | Effect Schema boundary in `scripts/profiles/model.ts` |
| Homebrew | `Brewfile.personal` gates casks on profile capabilities |

Each consumer rejects unsupported versions, unknown profiles, missing fields,
and wrong value types.

Brewfile order per profile:

| Profile | Layers, in order |
| --- | --- |
| `personal-workstation` | `Brewfile`, `Brewfile.developer`, `Brewfile.workstation`, `Brewfile.personal` |
| `personal-devbox` | `Brewfile`, `Brewfile.developer`, `Brewfile.devbox`, `Brewfile.personal` |
| `workstation` | `Brewfile`, `Brewfile.developer`, `Brewfile.workstation` |
| `devbox` | `Brewfile`, `Brewfile.developer`, `Brewfile.devbox` |
| `assistant` | `Brewfile`, `Brewfile.assistant` |

- The shared `Brewfile` base includes Chrome and `gh`.
- `Brewfile.personal` declarations are profile-aware: GUI casks install only for
  `personal-workstation`.
- Assistant skips the developer layer.

What each layer supplies:

- `Brewfile.developer`, shared by `personal-workstation`, `personal-devbox`,
  `workstation`, and `devbox`: Codex CLI, Claude Code CLI, OpenCode,
  slopguard, slopmachine, GitLab CLI, Watchman, Docker and its credential
  helper, AWS CLI, XcodeGen, `xcodes`, Android command-line tools, and the
  shell, secret, and network scanning tools.
- Cursor Agent CLI comes from the `install-cursor-agent` install step, not a
  Brewfile.
- The development runtime set, including mise-managed Ruby, comes from the
  `developer` runtime group through `install-runtimes`.
- `Brewfile.workstation`, used by `personal-workstation` and `workstation`:
  1Password and its CLI, Slack, ChatGPT, Claude, Cursor, T3 Code, Zed, Ghostty,
  and YubiKey Manager.
- `Brewfile.personal`, used by both personal profiles: App Store Connect CLI,
  Attach, Crabbox, Discrawl, Gitcrawl, Pi, putio-cli, and Mole. Only
  `personal-workstation` also gets personal applications such as Slopwake and
  the Google Cloud CLI, plus `mas`.
- `Brewfile.assistant`: portable document, media, Google, and macOS automation
  tools.
- Developer profiles manage the Codex, Claude Code, OpenCode, and Cursor Agent
  CLIs. Personal profiles add Pi, workstation profiles add T3 Code and Zed,
  and personal workstations add Grok Build. Workstation profiles also add the
  ChatGPT, Claude, and Cursor desktop apps.

Runtimes and dotfiles:

- Developer-profile install flows apply machine-global instructions through
  chezmoi and sync additive skills from `scripts/agents/`; see
  [Agent setup](agents.md).
- Both workstation profiles manage Zed settings and keymap through chezmoi.
  All profiles set `EDITOR`/`VISUAL` to `vim`. Zed stays a thin editor: vim
  on, AI off, telemetry off, and collaboration chrome hidden.
- The assistant mise config contains only Node. Workload repositories own
  OpenClaw, Hermes, model providers, containers, process supervision, language
  runtimes, and other framework-specific packages.
- Assistant dotfile application installs the shared Git base and the
  `gh-app-auth` execution adapter. It omits developer signing, human credential
  helpers, outbound SSH defaults, desktop settings, global coding-agent
  instructions, and development skills.

## Identity Policy

[Identity provisioning](identities.md) is the source of truth for age, Git,
SSH, GitHub App, recovery, and deployment lifecycle.

- `workstation`, `personal-workstation`, `personal-devbox`, and `devbox` users
  configure explicit human authorship and local signing.
- Assistants configure unsigned workload authorship and use a workload-owned
  GitHub App for repository access.
- Services configure unsigned workload authorship but receive authentication
  only from their owning workload.
- Identity values remain operator input and are never tracked.

## Apply a Profile

Run Homebrew changes from the authorized host administrator:

```zsh
./scripts/bootstrap/brew-bundle.ts personal-workstation
./scripts/bootstrap/brew-bundle.ts personal-devbox
./scripts/bootstrap/brew-bundle.ts workstation
./scripts/bootstrap/brew-bundle.ts devbox
./scripts/bootstrap/brew-bundle.ts assistant
```

Then run the per-user setup as the target Unix user:

```zsh
profile=workstation
mise trust
./dotfiles diff "$profile"
./dotfiles apply "$profile"
# Optional until this machine decrypts vault or other SOPS material:
# ./scripts/secrets/configure-sops-age-identity.ts
./dotfiles check "$profile"
```

- Use `profile=personal-workstation` for the personal workstation composition,
  or `profile=personal-devbox` for the personal devbox composition. The
  remaining steps are identical.
- Secret-consuming profiles (`personal-devbox`, `devbox`, `assistant`) still
  require the age-identity step before bootstrap verification.

Configure the appropriate human or workload Git identity separately:

```zsh
./scripts/bootstrap/configure-git.ts --profile "$profile"
```

Assistant workload authorship and GitHub App enrollment use the commands in
[Identity provisioning](identities.md#workload-git-authorship).

## Externally Managed Homebrew Capabilities

A workstation can accept a formula or cask from another trusted installer
without pretending Homebrew owns it. Create
`~/.config/dotfiles/external-homebrew.plist` as a regular XML property list
owned by the current user and not writable by group or other users.

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

| Validator | Requirements |
| --- | --- |
| `command` | Absolute executable path owned by the current user or root, not writable by group or other users. Runs up to three literal arguments. Use it when a safe version or health probe can prove that endpoint policy permits execution |
| `bundle` | Absolute nonsymlinked app bundle, exact bundle identifier, exact signing team, and a valid strict code signature |

Enforcement in `brew-bundle.ts` and bootstrap verification:

- Ambient Homebrew Bundle skip variables are rejected.
- macOS `plutil` lints the file and enforces root, version, record, field, and
  value types before setting a formula or cask skip list.
- Unknown entries, duplicates, failed commands, signature mismatches, unsafe
  permissions, and unreadable files fail closed.
- Delimiters, whitespace, and Unicode are normal plist string content.
