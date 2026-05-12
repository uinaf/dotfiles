# Security

## Reporting a Vulnerability

Email `dev@uinaf.dev`.

Do not open a public issue for secrets, credential exposure, signing key
problems, or anything that could help compromise a machine.

## Environment Secrets

Environment variables are process state, not secure storage. Any program run in
that environment can read them and pass them to child processes.

Do not place long-lived service tokens in shell startup files, launchd plists,
process-compose YAML, or tracked dotenv files. Store them in machine-local
secret storage, such as a root-owned token file on a headless devbox, and fetch
them inside the smallest wrapper that needs them. Generated secret files must be
owner-only, usually a `0711` root-owned directory and `0400` service-user-owned
file when another Unix user has to read them.

## What to Include

- Affected file, script, or setup step.
- Reproduction steps.
- Impact.
- Suggested mitigation, if you have one.

## Response Expectations

We triage reports as quickly as possible. This is a public dotfiles repo, so
most fixes should be small script, documentation, or configuration changes.
