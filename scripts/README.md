# Scripts

Scripts are grouped by functionality:

| Directory | Purpose |
| --- | --- |
| `app-store/` | Mac App Store app installs/removals through `mas`. |
| `audit/` | Check-only security and drift audits for repo, host, personal, and devbox contexts. |
| `bootstrap/` | Install and configure Homebrew, dotfiles, Git, Codex, Chrome, and repos. |
| `lib/` | Shared shell helpers used by scripts. |
| `secrets/` | 1Password service-account token storage and generated env refresh helpers. |
| `tizen/` | Samsung Tizen Studio install and certificate/profile archive helpers. |
| `verify/` | Deterministic repo, bootstrap, and devbox service-boundary verification. |

Run scripts from the repository root unless a script says otherwise.

## Common Commands

Repository-only verification:

```zsh
./scripts/verify/repo.sh
```

Install the local pre-push guard:

```zsh
./scripts/bootstrap/install-git-hooks.sh
```

Personal bootstrap:

```zsh

./scripts/bootstrap/brew-bundle.sh personal
./scripts/bootstrap/install.sh
./scripts/bootstrap/configure-chrome.sh
./scripts/bootstrap/configure-git.sh --profile personal
./scripts/app-store/personal.sh
./scripts/verify/bootstrap.sh --profile personal
```

Security audits:

```zsh

./scripts/audit/repo.sh --skip-mscp
./scripts/audit/host.sh
./scripts/audit/host.sh --json
./scripts/audit/personal.sh
./scripts/audit/personal.sh --json
```

Devbox checks:

```zsh

./scripts/verify/devbox-services.sh
./scripts/audit/devbox.sh
./scripts/audit/devbox.sh --json
```

Before committing script changes:

```zsh
./scripts/verify/repo.sh
```
