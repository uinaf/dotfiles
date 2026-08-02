# User Profiles

Profiles describe the role of one Unix user. They do not describe the whole
host and they are not a security boundary by themselves.

## Roles

| Profile | Intended user | Default capability |
| --- | --- | --- |
| `workstation` | Interactive human on a laptop or desktop | Full desktop, development, human authentication, and local containers |
| `devbox` | Remote coding identity on an SSH-first host | Coding agents, Git/GitHub, SDKs, containers, and verification tools |
| `assistant` | Unattended assistant or platform-service identity | Minimal runtimes, machine authentication, supervision, browser, and media support |

`personal` is a temporary command alias for `workstation`. New configuration
and documentation must use `workstation`.

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

All profiles install the minimal `Brewfile` base. Workstation and devbox also
install `Brewfile.developer`, followed by their profile layer. Assistant skips
the developer layer and installs only `Brewfile.assistant`.

The assistant mise config contains only Node. Workload repositories own
OpenClaw, Hermes, model providers, additional language runtimes, and other
workload-specific packages. Workstation and devbox retain the full shared
development runtime set, including Codex CLI, Claude Code CLI, and Cursor Agent
CLI. Their install flow also syncs machine-global instructions and additive
skills from `scripts/agents/`; see [Agent setup](agents.md). Zed and its managed
settings belong only to the workstation profile.

Assistant dotfile application installs a minimal Git base with an optional
assistant GitHub App include but no configured credentials. It skips developer
signing, human credential helpers, outbound SSH
configuration, Zed, and Ghostty state. It also skips developer worktree trust,
stable Corepack-managed pnpm setup, Codex desktop defaults, and developer-only GitHub
extensions. It does not install global coding-agent instructions or development
skills. The assistant install step adds a pinned `gh-app-auth` execution adapter
without provisioning credentials.

## Identity Policy

The complete capability, age, SSH, recovery, and deployment lifecycle is in
[Identity provisioning](identities.md).

Workstation and devbox users configure an explicit human Git identity with
`configure-git.sh`. Assistant users configure an explicit workload identity
with the same script. For assistants only, it writes `user.name` and
`user.email`, disables commit and tag signing, and marks the local config as
workload-owned. Workstation and devbox retain their explicit human signing
configuration. Identity values are local operator input and are never tracked.

Assistant GitHub authentication is separate from commit authorship. This
profile installs the command mechanism and optional Git include;
`configure-assistant-github-app.sh` binds an operator-supplied workload App to
exact repositories. The private key remains owner-only and tokens are minted on
demand. No human login, repository wrapper, or refresh daemon is required.

The assistant bootstrap checks the managed Git base and workload identity. It
does not inventory or clean unrelated user-home state; migration agents own
that work. Run the expected-contract check directly with
`./scripts/verify/assistant-git-boundary.sh`.

Unattended users use a per-deployment age identity for SOPS access. If a
workload needs repository access, provision a workload-owned GitHub App instead
of a human account. These dotfiles own the generic App and Git transport
configuration; the operator owns App creation, repository selection, private
key recovery, and encrypted provider payloads.

## Apply a Profile

Run Homebrew changes from the authorized host administrator:

```zsh
./scripts/bootstrap/brew-bundle.sh workstation
./scripts/bootstrap/brew-bundle.sh devbox
./scripts/bootstrap/brew-bundle.sh assistant
```

Then run the per-user setup as the target Unix user:

```zsh
./scripts/bootstrap/install.sh --profile <profile>
./scripts/secrets/configure-sops-age-identity.sh
mise trust
mise install
./scripts/verify/bootstrap.sh --profile <profile>
```

Configure the appropriate human or workload Git identity separately:

```zsh
./scripts/bootstrap/configure-git.sh --profile workstation
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

## Migrate an Existing User

This release is breaking. Profile application does not read, migrate, or
delete former owner-specific configuration, credentials, editor state,
runtimes, or services. Follow [Migrating to Role Profiles](migrating-to-role-profiles.md)
for the per-user inventory, manual path changes, service transition, and
verification checklist before applying a new role.
