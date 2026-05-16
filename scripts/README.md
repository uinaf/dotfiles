# Scripts

Scripts are grouped by functionality:

| Directory | Purpose |
| --- | --- |
| `app-store/` | Mac App Store app installs/removals through `mas`. |
| `audit/` | Check-only security and drift audits for repo, host, personal, and devbox contexts. |
| `bootstrap/` | Install and configure Homebrew, chezmoi dotfiles, Git, Codex, Chrome, and repos. |
| `lib/` | Shared shell helpers used by scripts. |
| `secrets/` | 1Password service-account token storage and generated env refresh helpers. |
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
./scripts/bootstrap/brew-bundle.sh personal
./scripts/bootstrap/brew-bundle.sh devbox
./scripts/bootstrap/brew-bundle.sh --shared-only
./scripts/bootstrap/apply-dotfiles.sh --dry-run --verbose
./scripts/bootstrap/install.sh
./scripts/bootstrap/configure-git.sh --profile personal
./scripts/bootstrap/configure-git.sh --profile devbox
./scripts/bootstrap/configure-power.sh --profile personal
./scripts/bootstrap/configure-power.sh --profile devbox
```

`configure-power.sh` is the explicit sudo step for plugged-in macOS power
policy. `install.sh` should stay user-level and applies the repo-local chezmoi
source state before configuring Codex defaults.

Use [Bootstrap guide](../docs/bootstrap.md) for the ordered personal and devbox
flows.

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
./scripts/audit/personal.sh
./scripts/audit/personal.sh --json
mise run audit:personal
mise run audit:personal:json
```

Devbox checks:

```zsh
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
