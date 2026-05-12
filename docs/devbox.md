# Devbox Setup

Devbox automation keeps always-on agent users reproducible without making their
secrets or identities part of the public dotfiles repo.

## Boundaries

Tracked here:

- portable tools in `Brewfile` and `Brewfile.devbox`
- shared shell, Git, SSH, mise, editor, and Codex defaults
- public-safe scripts and validation
- templates and contracts for local service setup

Local only:

- Git identities, signing keys, and 1Password SSH vaults
- 1Password service-account tokens and item references
- OpenClaw env values and generated service state
- process-compose ports when they are identity-specific
- Codex auth, trusted paths, sessions, and agent-rule symlinks

## Secret Model

Environment variables are not a secret boundary. Any package, shell command, or
child process running with a populated environment can read it.

Use this pattern for service secrets:

1. Store the 1Password service-account token in machine-local secret storage.
   On a headless devbox, use a root-owned token file rather than a user login
   keychain that may require GUI unlock.
2. Fetch it inside a narrow wrapper immediately before `op` needs it.
3. Keep raw tokens out of shell startup, launchd plists, process-compose YAML,
   tracked files, and long-lived interactive shells.
4. Sync one 1Password item whose env-shaped fields render the generated dotenv.
5. Write generated dotenv files through a temp file into a root-owned runtime
   env directory. The generated file should be readable only by the target
   service user, such as mode `0400`.
6. Start long-lived services from process-compose with the minimum env they need.
7. Run untrusted project commands from ordinary shells that do not have service
   tokens exported.

Personal laptops can lean on the 1Password desktop app and manual approval.
Headless devbox users need service accounts, but the token should still be
scoped, stored locally outside user-writable paths, and loaded only by wrappers.

Store service-account tokens in a human/admin vault, not in the vault the token
can read. The key to a vault should not live inside the vault it unlocks. For
example, if a devbox service account can read `<context>-devbox`, store that
service-account token in a separate human/admin vault and copy it into the
machine's OS secret manager during bootstrap.

## Vault Topology

Use vaults to model capability boundaries. A vault should answer "which runtime
needs this secret?" rather than "which human knows about this project?"

Use this generic split:

| Context | Vault | Access |
| --- | --- | --- |
| Human operations | `<context>` | Humans only. |
| Devbox agents | `<context>-devbox` | One service account for that devbox identity. |
| CI | `<context>-ci` | GitHub Actions or the relevant CI runtime only. |
| Shared CI lane | `<lane>-ci` | Only the CI jobs for that lane. |

Do not share service-account tokens across these vaults. CI, devbox agents, and
humans are different runtimes and should get different credentials even when
they work on related projects.

The token storage vault and the token access scope are different things:

- token storage: human/admin vault
- token access: only the runtime vaults the service account needs

## Identity Boundaries

Shared devboxes may host multiple agent identities. Keep their Unix users, Git
identity, GitHub auth, SSH keys, Codex/Claude config, trusted project paths,
workspaces, and 1Password vault access separate.

The goal is to avoid ambient cross-context access. A compromised package,
agent session, or service in one identity should not automatically get another
identity's Slack, GitHub, CI, or 1Password capabilities.

If an identity needs access outside its normal context for a specific task,
grant it explicitly and temporarily, then remove that access after the task.

## Local Contract

Each devbox user should have a local config file outside Git:

```sh
UINAF_DEVBOX_USER=example
UINAF_PROCESS_COMPOSE_SOCKET="/Users/example/.local/run/process-compose.sock"
UINAF_OP_SERVICE_ACCOUNT_TOKEN_FILE="/var/db/uinaf/devbox-secrets/example/op-sa-token"
UINAF_OPENCLAW_ENV_FILE="/var/db/uinaf/devbox-env/example/openclaw.env"
```

The file should be mode `0600`. If a user needs 1Password item references,
keep them in local config or 1Password, not in this repo.

If a devbox identity does not run process-compose, set
`UINAF_PROCESS_COMPOSE_ENABLED=0` in its local config so verification does not
accidentally query another user's supervisor.

## Supervisor

Use process-compose as the per-user supervisor for always-on agent services
when the identity needs it. Launchd should start process-compose;
process-compose should own service restart policy, logs, health checks, and
one-shot tasks.

Prefer a per-user Unix socket over a shared localhost TCP port:

```text
~/.local/run/process-compose.sock
```

Do not reuse another identity's process-compose port or socket.

Do not put secrets directly into the launchd plist or process-compose YAML.
Instead, run a root-owned refresh helper that reads the local service-account
token, fetches one 1Password item, renders env-shaped fields from that item,
validates the generated dotenv, and writes the generated runtime env file. User
services should read the generated runtime env file, never the service-account
token.

The generated env path should live outside user-writable directories, for
example:

```text
/var/db/uinaf/devbox-env/<identity>/openclaw.env
```

Use a compatibility symlink from `~/.openclaw/.env` only when a service still
expects that path.

Install the root-owned refresh helper with explicit local values:

```zsh
sudo ./scripts/install-devbox-env-refresh.sh \
  --identity example \
  --target-user example \
  --op-account example.1password.com \
  --op-vault example-devbox \
  --required-keys 'OPENAI_API_KEY OPENCLAW_GATEWAY_TOKEN'
```

Then install the service-account token at the path printed by the installer:

```zsh
op read 'op://<human-vault>/<service-account-token-item>/password' \
  | sudo ./scripts/install-devbox-op-token.sh --identity example
```

The token file must be root-owned and mode `0400` or `0600`. The helper reads
the item named `OPENCLAW_ENV` by default and writes the validated dotenv content
from env-shaped item fields into:

```text
/var/db/uinaf/devbox-env/<identity>/openclaw.env
```

That generated file is owned by the target service user and mode `0400`.

## Verification

Run the normal bootstrap check for each user:

```zsh
./scripts/verify.sh --profile devbox
```

Run the devbox-specific boundary check for each devbox user:

```zsh
./scripts/verify-devbox.sh
```

That check verifies the supervisor binary, process-compose state, secret-file
modes, absence of default shell token export, and the configured root-owned
service-account token file.

Run the devbox security audit for each devbox user:

```zsh
./scripts/security-audit-devbox.sh
```

That audit is stricter than verification. It checks for stale secret-looking
backups, generated env symlink drift, Git/GitHub identity state, SSH key file
permissions, admin group drift, Tailscale health, and raw service-account token
references in local service config. It does not print secret values.

For OS-level posture, run `./scripts/security-audit.sh` after generating a
macOS Security Compliance Project check-only script for the host's macOS
version. Start with check-only results and review exceptions before applying
any remediation outside this repo. See [Security audits](security-audits.md) for
the full audit model.
