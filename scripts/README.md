# Scripts

Scripts are grouped by operational surface:

| Directory | Purpose |
| --- | --- |
| `bootstrap/` | Mac bootstrap, local config, repo sync, and functional verification. |
| `security/` | Repo, macOS posture, and personal-machine audit checks. |
| `devbox/` | Shared agent-host setup, token/env refresh, and devbox audit checks. |
| `lib/` | Shared shell helpers used by scripts. |
| `tizen/` | Samsung Tizen Studio install and certificate/profile archive helpers. |

Run scripts from the repository root unless a script says otherwise.

## Common Commands

Repository-only verification:

```zsh
./scripts/bootstrap/verify-repo.sh
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
./scripts/bootstrap/verify.sh --profile personal
```

Security audits:

```zsh

./scripts/security/audit.sh --skip-mscp
./scripts/security/audit-host.sh
./scripts/security/audit-host.sh --json
./scripts/security/audit-personal.sh
./scripts/security/audit-personal.sh --json
```

Devbox checks:

```zsh

./scripts/devbox/verify.sh
./scripts/devbox/security-audit.sh
./scripts/devbox/security-audit.sh --json
```

Before committing script changes:

```zsh
./scripts/bootstrap/verify-repo.sh
```
