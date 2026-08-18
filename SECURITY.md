# Security

## Report a Vulnerability

Email `dev@uinaf.dev`. Do not open a public issue for credential exposure,
signing-key problems, or machine-compromise paths.

Include the affected file or setup step, reproduction, impact, and a suggested
mitigation when available. Do not include secret values or private identity
material.

## Protect Local Secrets

Environment variables are process state, not durable secret storage. Store
long-lived credentials through the SOPS/age model in
[Identity provisioning](docs/identities.md), and expose plaintext only at the
intended consumer boundary.

- Keep service tokens and private identity material out of shell startup,
  launchd plists, supervisor configs, tracked dotenv files, and generated runtime
  env files.
- Private age identities stay owner-only.
- Unattended workloads do not receive human secret-manager sessions.

## Audit

Run the repository gate before submitting security-sensitive changes:

```zsh
./scripts/verify/repo.sh
```

Use the matching live audit only on the intended machine or Unix user:

```zsh
mise run audit host
mise run audit workstation
mise run audit devbox
```

- These checks are non-destructive and redact or summarize findings where the
  underlying tools allow it.
- Treat raw audit output as sensitive.
- See [Security audits](docs/security-audits.md) for scope, JSON output, and mSCP
  setup.

## Response

Reports are triaged privately. Public remediation should contain only the
minimum portable code, configuration, and documentation needed to close the
issue.
