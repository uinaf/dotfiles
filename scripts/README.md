# Scripts

Scripts are grouped by functionality:

| Directory | Purpose |
| --- | --- |
| `app-store/` | Mac App Store app installs/removals through `mas`. |
| `audit/` | Check-only security and drift audits for repo, host, workstation, and devbox contexts. |
| `bootstrap/` | Install and configure Homebrew, chezmoi dotfiles, Git, Codex, and Chrome. |
| `lib/` | Shared shell helpers used by scripts. |
| `secrets/` | Owner-local secret-manager bootstrap and command-boundary wrappers. |
| `tizen/` | Samsung Tizen Studio install and certificate/profile archive helpers. |
| `verify/` | Deterministic repo, bootstrap, and devbox service-boundary verification. |

Run scripts from the repository root unless a script says otherwise.
Mise task wrappers live in `.mise/tasks/` and call these scripts; keep reusable
logic here so scripts remain lintable and directly runnable during bootstrap.

## Common Commands

Repository-only verification:

```zsh
./scripts/verify/repo.sh
mise run verify
mise run verify:fast
```

Install the local pre-push guard:

```zsh
./scripts/bootstrap/install-git-hooks.sh
```

Bootstrap entry points:

```zsh
./scripts/bootstrap/brew-bundle.sh workstation
./scripts/bootstrap/brew-bundle.sh devbox
./scripts/bootstrap/brew-bundle.sh assistant
./scripts/bootstrap/brew-bundle.sh --shared-only workstation
./scripts/bootstrap/brew-bundle.sh --shared-only devbox
./scripts/bootstrap/brew-bundle.sh --shared-only assistant
./scripts/bootstrap/brew-devbox.sh upgrade
./scripts/bootstrap/apply-dotfiles.sh --profile workstation --dry-run --verbose
./scripts/bootstrap/install-blacksmith.sh
./scripts/bootstrap/install-cursor-agent.sh
./scripts/bootstrap/install-gh-extensions.sh
./scripts/bootstrap/install.sh --profile workstation
./scripts/bootstrap/configure-git.sh --profile workstation
./scripts/bootstrap/configure-git.sh --profile devbox
GIT_USER_NAME='Workload Name' GIT_USER_EMAIL='APP_BOT_NOREPLY_EMAIL' \
  ./scripts/bootstrap/configure-git.sh --profile assistant --non-interactive
./scripts/bootstrap/configure-power.sh --profile workstation
./scripts/bootstrap/configure-power.sh --profile devbox
./scripts/bootstrap/configure-spotlight.sh
./scripts/bootstrap/configure-desktop.sh
./scripts/bootstrap/install-devbox-service-daemons.sh --user example --namespace org.example.dotfiles --print-labels
./scripts/bootstrap/trust-agent-worktrees.sh
```

`configure-power.sh` and `configure-spotlight.sh` are explicit sudo steps for
macOS system policy. `install.sh` should stay user-level.
`brew-devbox.sh` scopes a group-safe umask to shared Homebrew mutations;
`brew-bundle.sh devbox` uses it automatically.
`configure-desktop.sh` is an explicit owner-profile step for the black devbox
desktop, hidden widgets/icons, and Chrome-only Dock. It supports `--check` and
is not applied to other devbox users by `install.sh`.

Use [User profiles](../docs/profiles.md) and the [Bootstrap guide](../docs/bootstrap.md)
for the ordered workstation, devbox, and assistant flows.

Security audits:

```zsh
./scripts/audit/repo.sh --skip-mscp
mise run audit:repo
mise run audit:repo:json
mise run audit:mscp
./scripts/audit/host.sh
./scripts/audit/host.sh --json
mise run audit:host
mise run audit:host:json
./scripts/audit/workstation.sh
./scripts/audit/workstation.sh --json
mise run audit:workstation
mise run audit:workstation:json
```

Devbox checks:

```zsh
./scripts/secrets/configure-infisical-devbox.sh
./scripts/secrets/configure-infisical-devbox-sudo.sh
<concealed-password-command> | ./scripts/secrets/infisical-devbox-sudo-seal.sh
./scripts/secrets/infisical-devbox-run.sh -- <command>
./scripts/secrets/infisical-devbox-sudo.sh -- <non-interactive-command>
./scripts/verify/devbox-services.sh
mise run verify:devbox-services
./scripts/audit/devbox.sh
./scripts/audit/devbox.sh --json
mise run audit:devbox
mise run audit:devbox:json
```

Before committing script changes:

```zsh
./scripts/verify/repo.sh
```
