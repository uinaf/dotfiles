# Devbox Setup

Devbox automation keeps dedicated Unix users reproducible without making
secrets or identities part of the public dotfiles repository. Personal-devbox
uses the devbox operational contract with headless personal tools and skills. Assistant and
service profiles reuse the same Unix-user and service boundaries without
inheriting the coding toolchain or a human Git identity. Services remain
non-persona workloads and do not inherit assistant runtime or authentication.
See [Identity provisioning](identities.md).

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

Each identity gets its own Unix user, home directory, Git identity, age
identity, agent homes, workspaces, and service state. Provision GitHub and
outbound SSH capabilities only when that identity needs them. Grant
cross-context access explicitly and temporarily.

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

## Sudo Without a Plaintext Password File

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

## GitHub and SSH

Human devbox users may keep their own GitHub account and SSH signing key.
Unattended identities should use a repository-scoped GitHub App installation
token and a separate commit identity. Git author metadata is not an
authorization mechanism; HTTPS push and GitHub API operations use the short-
lived App token.

Devbox Git repositories normally use SSH remotes for human identities.
`configure-git.sh --profile devbox` (or `personal-devbox`) writes a
`Host github.com` override in
`~/.ssh/github.config` when the signing key is a local path.

## Local Contract

Optional per-user service settings live outside Git at
`~/.config/dotfiles/devbox.env` with mode `0600`:

```sh
DEVBOX_USER=example
```

Do not create broad workspace env bundles or load secrets in shell startup.

## Opt-In Coding LLM Gateway

Developer-profile users may route Codex and Claude Code through a private LLM
gateway and run Cursor Agent with an identity-owned API key. This capability is
off until the identity creates an owner-only local configuration file. It does
not change assistant or service profiles, and it does not store secrets in
shell startup, Codex configuration, or Claude settings.

Create `~/.config/dotfiles/llm-gateway.json` with mode `0600`:

```json
{
  "version": 1,
  "secretFile": "/Users/example/projects/example/vault/secrets/identity/example-coding.sops.env",
  "gatewayBaseUrl": "https://gateway.example/v1",
  "cursorAgentBin": "/Users/example/.local/share/cursor-agent/versions/2026.08.11-e8db854/cursor-agent"
}
```

The SOPS payload must provide `CLIPROXYAPI_CLIENT_API_KEY` and
`CURSOR_API_KEY`. The configurator installs owner-only process helpers, backs
up the current Codex and Claude settings once, and uses Codex's native atomic
config writer to select a command-authenticated Responses provider:

```bash
./scripts/bootstrap/configure-llm-gateway.ts
./scripts/bootstrap/configure-llm-gateway.ts --check
```

The first enrollment keeps any saved Codex login intact. The standard bootstrap
does not force a login method. Remove the saved login only in the separate,
explicit auth-retirement step after the gateway and rollback path are accepted.

After the gateway has been accepted, retire the three coding-client login
caches through their supported logout commands and remove Codex's obsolete
login-method restriction:

```bash
./scripts/bootstrap/configure-llm-gateway.ts --retire-auth
./scripts/bootstrap/configure-llm-gateway.ts --check
```

This is intentionally separate from enrollment. It is idempotent, keeps the
gateway configuration and encrypted credential payload in place, and does not
touch GitHub, SSH, OpenClaw, or connector credentials. Rollback after retirement
restores the pre-gateway client configuration but cannot restore deleted login
credentials; each coding client must be authenticated again before direct use.

A complete developer-profile `install.sh` run preserves gateway routing and
removes any legacy Codex login-method restriction.

Claude Code receives `ANTHROPIC_BASE_URL` and `apiKeyHelper` in its existing
user settings. Every unrelated setting remains in place, and enrollment alone
does not remove the saved Claude login. Enrollment fails if the settings
already define `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, Bedrock, or Vertex selection because those values take
precedence over the gateway helper. Remove that conflict deliberately before
enrollment instead of silently routing around it.

The configurator records the exact installer-managed symlink targets, then
replaces `~/.local/bin/cursor-agent` and `~/.local/bin/agent` with the API-key
launcher. This covers interactive shells and automation that executes either
canonical path directly. `cursorAgentBin` must therefore point to Cursor's
versioned vendor executable, never one of those launcher paths. The standalone
`~/.local/bin/cursor-agent-api` path remains available for explicit calls.

The launcher blocks `login` and `logout` while enabled so a help or diagnostic
command cannot start browser authentication. It reports API-key health through
`status`, `whoami`, and `about` after a provider model check, including a
synthetic `api-key@local` identity for tools that parse `agent about`. ACP
`authenticate` is acknowledged locally so clients that always send
`cursor_login` do not start a browser flow. Cursor installer upgrades
automatically reapply the managed commands.

Rollback restores the exact pre-enrollment Codex config, Claude settings, and
Cursor command symlinks, then removes the helpers. Saved coding login state is
untouched unless the separate `--retire-auth` operation was run:

```bash
./scripts/bootstrap/configure-llm-gateway.ts --rollback
```

## System Services

Install selected boot services from an authorized administrator account. The
installer creates root-owned system LaunchDaemons that drop privileges to the
target user:

For an OpenClaw workload, pass its user-owned executable wrapper and unique
gateway port:

```zsh
sudo ./scripts/bootstrap/install-devbox-service-daemons.sh \
  --user example \
  --openclaw \
  --openclaw-wrapper /Users/example/.local/bin/openclaw-wrapper \
  --openclaw-port 18789 \
  --allow-openclaw-restart
```

`--allow-openclaw-restart` grants that user passwordless restart of only its
exact OpenClaw system job. It does not grant general launchctl or sudo access.
Use `--colima` only when that target user owns the service.
Use `--check` with the selected service flags for a non-mutating contract
check.

System LaunchDaemons must be root-owned and mode `0644`. They may reference
owner-only files and wrappers but must never embed secret values. Retire a
competing user LaunchAgent before installing a system service for the same
process.

## Verification

Run each check as the intended Unix identity:

```bash
./dotfiles check devbox
./scripts/verify/devbox-services.sh
mise run audit devbox --format json
```

Use `./dotfiles check personal-devbox` for the bootstrap check on an
owner-operated personal devbox. The service verification and audit commands
are unchanged.

The bootstrap gate checks the selected profile packages and shared config. The
service gate verifies the age identity, local config, and launchd boundary. The
audit additionally checks stale secret-looking files, Git/GitHub identity, SSH
permissions, project privacy, Tailscale health, and local service state.

Treat prose audit output as sensitive because scanners may include matched
material. Prefer `--json` for remote collection and summarize findings by
detector, path, and line number.
