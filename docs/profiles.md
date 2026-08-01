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

The assistant mise config contains Node, Python, and uv. Workload repositories
own OpenClaw, Hermes, model providers, and other workload-specific packages.
Workstation and devbox retain the full shared development runtime set.

Assistant dotfile application installs a minimal Git base and an HTTPS wrapper
for ephemeral GitHub App tokens. It skips developer signing, credential
helpers, outbound SSH configuration, Zed, and Ghostty state. It also skips
GitHub extensions, developer worktree trust, native pnpm setup, and Codex
desktop defaults.

## Identity Policy

Workstation and devbox users configure an explicit human Git identity with
`configure-git.sh`. Assistant users configure an explicit workload identity
with the same script. It writes `user.name`, `user.email`, disables commit and
tag signing, and marks the local config as workload-owned. The values are local
operator input and are never tracked.

Assistant GitHub authentication is separate from commit authorship. Use a
short-lived GitHub App installation token over an HTTPS remote through
`~/.local/bin/git-as-github-app`. Do not persist the token in the remote URL, Git
configuration, `gh auth`, or SSH keys. The wrapper reads
`GITHUB_APP_INSTALLATION_TOKEN` only from the command environment.

The assistant bootstrap checks the managed workload identity and common
user-home credential locations. It is not proof about system Git/SSH
configuration or repository-local configuration elsewhere on the host.
Clean-user provisioning and scoped runtime credentials are the security
boundary. Run the check directly with
`./scripts/verify/assistant-git-boundary.sh`.

Unattended users use a scoped machine identity for secret access. If a workload
needs repository access, provision a workload-owned GitHub App instead of a
human account.

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
```

## Migrate an Existing User

Preview dotfile changes before applying a new role:

```zsh
./scripts/bootstrap/apply-dotfiles.sh --profile <profile> --dry-run --verbose
```

Profile application adds or updates declared state. It does not uninstall
host-wide Homebrew packages or delete existing credentials, editor state,
runtimes, or service data. Audit and remove those separately only after proving
that retained workloads do not depend on them.

On apply, known files from the legacy `~/.config/uinaf` namespace move to
`~/.config/dotfiles` when the canonical target does not already exist. A
conflicting legacy file is retained and reported instead of overwritten.
