# Security

## Reporting a Vulnerability

Email `dev@uinaf.dev`.

Do not open a public issue for secrets, credential exposure, signing key
problems, or anything that could help compromise a machine.

## Environment Secrets

Environment variables are process state, not secure storage. Any program run in
that environment can read them and pass them to child processes.

Do not place long-lived service tokens, Infisical access tokens, or machine
identity credentials in shell startup files, launchd plists, process-compose
YAML, tracked dotenv files, or generated runtime env files.

Human-operated machines may use human secret-manager sessions. Agent devboxes
use Infisical machine identity auth through the devbox contract in
[Devbox setup](docs/devbox.md): persistent Universal Auth client credentials
live only in owner-only local config, and short-lived access tokens are minted
for the smallest command boundary that needs them.

## Local Audits

Run `./scripts/audit/repo.sh` for repo secret scans and optional
check-only macOS Security Compliance Project checks. Run
`./scripts/audit/personal.sh` on personal Macs and
`./scripts/audit/devbox.sh` on each shared devbox user to check local
secret boundaries, identity state, and common stale backup locations. These
scripts are non-destructive and do not print secret values.

See [Security audits](docs/security-audits.md) for the audit layers, mSCP setup,
CI secret scanning, devbox drift checks, and maintenance rules.

## What to Include

- Affected file, script, or setup step.
- Reproduction steps.
- Impact.
- Suggested mitigation, if you have one.

## Response Expectations

We triage reports as quickly as possible. This is a public dotfiles repo, so
most fixes should be small script, documentation, or configuration changes.
