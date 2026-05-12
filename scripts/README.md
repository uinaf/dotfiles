# Scripts

Scripts are grouped by operational surface:

| Directory | Purpose |
| --- | --- |
| `bootstrap/` | Mac bootstrap, local config, repo sync, and functional verification. |
| `security/` | Repo, macOS posture, and personal-machine audit checks. |
| `devbox/` | Shared agent-host setup, token/env refresh, and devbox audit checks. |
| `tizen/` | Samsung Tizen Studio install and certificate/profile archive helpers. |

Run scripts from the repository root unless a script says otherwise.

## Common Commands

```zsh
./scripts/bootstrap/brew-bundle.sh personal
./scripts/bootstrap/install.sh
./scripts/bootstrap/configure-git.sh --profile personal
./scripts/bootstrap/verify.sh --profile personal

./scripts/security/audit.sh --skip-mscp
./scripts/security/audit-personal.sh

./scripts/devbox/verify.sh
./scripts/devbox/security-audit.sh
```

Before committing script changes:

```zsh
find scripts -name '*.sh' -print0 | xargs -0 bash -n
find scripts -name '*.sh' -print0 | xargs -0 shellcheck
```
