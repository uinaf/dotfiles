# Agent Readiness

This repo is a Mac bootstrap and dotfiles repo, not a long-running app. Agent
readiness means agents can validate repo changes mechanically and can tell
whether a target machine matches the expected bootstrap shape.

## Current Grade

| Dimension | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Bootable | pass | `scripts/bootstrap/brew-bundle.sh` installs shared plus profile layers; `scripts/bootstrap/install.sh` links tracked files. | First-time macOS setup still needs Command Line Tools, Homebrew, and GitHub auth. |
| Testable | pass | `scripts/bootstrap/verify-repo.sh` runs syntax checks, ShellCheck, Actionlint, diff hygiene, entrypoint sanity, and repo secret scans. | Live machine behavior still needs a matching personal or devbox host. |
| Observable | partial | Verification and audit scripts print sectioned output; GitHub Actions exposes logs for repo checks and secret scans. | No structured machine-readable report format yet. |
| Verifiable | pass | `.github/workflows/verify.yml`, `.github/workflows/secrets.yml`, `scripts/bootstrap/verify.sh`, and `scripts/devbox/verify.sh`. | Devbox process-compose and service-token checks are host-local by design. |

Overall grade: **B for a bootstrap repo**. The repo has a single local
verification command and CI gates for repo changes. The remaining gaps are
machine-local observability and optional pre-push hook installation.

## Agent Workflow

For repository changes, run:

```zsh
./scripts/bootstrap/verify-repo.sh
```

For live bootstrap checks, run the profile that matches the machine:

```zsh
./scripts/bootstrap/verify.sh --profile personal
./scripts/bootstrap/verify.sh --profile devbox
```

For devbox boundary checks, run from each devbox user:

```zsh
./scripts/devbox/verify.sh
./scripts/devbox/security-audit.sh
```

Use `./scripts/security/audit.sh --skip-mscp` for repository secret scanning
without the host-level macOS Security Compliance Project audit.

## Non-Goals

- This repo does not provide app e2e tests, seed data, or service health
  endpoints because it does not run an application.
- This repo does not make machine-local secrets, Codex state, browser profiles,
  or service-account tokens part of Git.
- This repo does not automatically remediate mSCP findings.
