# Devbox Setup

Devbox automation keeps dedicated Unix users reproducible without making
secrets or identities part of the public dotfiles repository. Assistant
profiles reuse the same Unix-user and service boundaries without inheriting the
coding toolchain or a human Git identity. See [Identity
provisioning](identities.md).

## Boundaries

Tracked here:

- portable profile packages and shared shell defaults
- public-safe Git, SSH, SOPS, launchd, and supervisor tooling
- profile contracts, audit scripts, and verification

Local only:

- Git identities, signing keys, GitHub authorization, and browser sessions
- private age identities and owner-only devbox config
- workspace payloads, product env files, service state, logs, and sockets
- Codex and Claude authentication, sessions, and trusted paths

Each identity gets its own Unix user, home directory, Git identity, GitHub
authorization, SSH keys, age identity, agent homes, workspaces, and service
state. Grant cross-context access explicitly and temporarily.

## Secret Model

SOPS ciphertext belongs in a private capability-scoped vault repository. Each
Unix identity has a dedicated age identity at the standard SOPS path, with the
private key mode `0600` and parent directory mode `0700`. Back it up through an
approved human recovery system before encrypting live secrets.

Repository access grants ciphertext access; the SOPS recipient list grants
decryption. Both are required. Product repos should consume env vars,
owner-only prepared files, or CI secrets instead of containing secret-manager
clients.

Provision or verify the age identity:

```bash
./scripts/secrets/configure-sops-age-identity.sh
./scripts/secrets/configure-sops-age-identity.sh --check
./scripts/secrets/configure-sops-age-identity.sh --print-recipient
```

Use `SOPS_AGE_KEY_FILE` only when the deployment intentionally uses a
non-default owner-only path.

## Sudo Without A Plaintext Password File

An identity that needs unattended narrow sudo commands can store
`SUDO_PASSWORD_AGE` inside its SOPS payload. The inner age ciphertext uses the
dedicated sudo age identity, while SOPS controls access to the outer payload.

Configure these owner-only paths in `~/.config/dotfiles/devbox.env`:

```sh
SOPS_SUDO_SECRET_FILE="$HOME/projects/example/vault/secrets/identity/user-sudo.sops.json"
SUDO_AGE_IDENTITY_FILE="$HOME/.config/dotfiles/sudo-age-identity.txt"
```

Run a fixed command directly or allow a child process to make its own narrow
sudo calls:

```bash
./scripts/secrets/sops-devbox-sudo.sh -- /bin/launchctl kickstart -k system/example.service
./scripts/secrets/sops-devbox-sudo.sh --nested -- ./scripts/service/restart.sh
```

The password exists only in the askpass process. Keep the sudoers allowlist as
the primary authorization boundary and use the nested mode only when the child
command itself must stay unprivileged.

## GitHub And SSH

Human devbox users may keep their own GitHub account and SSH signing key.
Unattended identities should use a repository-scoped GitHub App installation
token and a separate commit identity. Git author metadata is not an
authorization mechanism; HTTPS push and GitHub API operations use the short-
lived App token.

Devbox Git repositories normally use SSH remotes for human identities.
`configure-git.sh --profile devbox` writes a `Host github.com` override in
`~/.ssh/github.config` when the signing key is a local path.

## Local Contract

Optional per-user service settings live outside Git at
`~/.config/dotfiles/devbox.env` with mode `0600`:

```sh
DEVBOX_USER=example
PROCESS_COMPOSE_SOCKET="$HOME/.local/run/process-compose.sock"
```

Set `PROCESS_COMPOSE_ENABLED=0` when the user runs no process-compose services.
Do not create broad workspace env bundles or load secrets in shell startup.

## Supervisor

Use process-compose as the per-user supervisor for long-running agent services.
Launchd starts process-compose; process-compose owns restart policy, health
checks, logs, and one-shot tasks. Prefer a per-user Unix socket:

```text
~/.local/run/process-compose.sock
```

System LaunchDaemons must be root-owned and mode `0644`. They may reference
owner-only files and wrappers but must never embed secret values.

## Verification

Run each check as the intended Unix identity:

```bash
./scripts/verify/bootstrap.sh --profile devbox
./scripts/verify/devbox-services.sh
./scripts/audit/devbox.sh --json
```

The bootstrap gate checks the selected profile packages and shared config. The
service gate verifies the age identity, local config, launchd boundary, and
process-compose instance. The audit additionally checks stale secret-looking
files, Git/GitHub identity, SSH permissions, project privacy, Tailscale health,
and local service state.

Treat prose audit output as sensitive because scanners may include matched
material. Prefer `--json` for remote collection and summarize findings by
detector, path, and line number.
