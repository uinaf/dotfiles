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
- workspace env values and generated service state
- process-compose ports when they are identity-specific
- Codex auth, trusted paths, sessions, and agent-rule symlinks

## Secret Model

Environment variables are not a secret boundary. Anything running in that
process tree can read them.

Use this pattern for service secrets:

1. Store the 1Password service-account token in machine-local secret storage,
   usually a root-owned token file on headless devboxes.
2. Keep raw tokens out of shell startup, launchd plists, process-compose YAML,
   tracked files, and long-lived interactive shells.
3. Sync one 1Password item whose env-shaped fields render the generated dotenv.
4. Write the generated dotenv under `/var/db/uinaf/devbox-env/<identity>/`,
   readable only by the target service user.
5. Start services with the generated env file.

Personal laptops can use the 1Password desktop app and manual approval.
Headless devboxes should use narrowly scoped service accounts loaded only by
wrappers.

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

Store service-account tokens in a human/admin vault, not in the vault the token
can read.

## Identity Boundaries

Shared devboxes may host multiple agent identities. Keep their Unix users, Git
identity, GitHub auth, SSH keys, Codex/Claude config, trusted project paths,
workspaces, and 1Password vault access separate.

The goal is to avoid ambient cross-context access. A compromised package,
agent session, or service in one identity should not automatically get another
identity's Slack, GitHub, CI, or 1Password capabilities.

If an identity needs access outside its normal context for a specific task,
grant it explicitly and temporarily, then remove that access after the task.

For GitHub, devbox repos should use SSH remotes. The per-user GitHub key should
come from that identity's 1Password-backed SSH key material, exported to an
owner-only local key file during bootstrap. Because the 1Password desktop SSH
agent socket may not exist in SSH sessions, `configure-git.sh --profile devbox`
writes a `Host github.com` override in `~/.ssh/config.local` when the signing
key is a local path. That override uses the local key file directly and sets
`IdentityAgent none` for GitHub only.

## Local Contract

Each devbox user should have a local config file outside Git:

```sh
UINAF_DEVBOX_USER=example
UINAF_PROCESS_COMPOSE_SOCKET="/Users/example/.local/run/process-compose.sock"
UINAF_OP_SERVICE_ACCOUNT_TOKEN_FILE="/var/db/uinaf/devbox-secrets/example/op-sa-token"
UINAF_WORKSPACE_ENV_FILE="/var/db/uinaf/devbox-env/example/workspace.env"
UINAF_WORKSPACE_ENV_LINK="/Users/example/projects/workspace/.env"
```

The file should be mode `0600`. If a user needs 1Password item references,
keep them in local config or 1Password, not in this repo. Omit
`UINAF_WORKSPACE_ENV_LINK` when no workspace-local `.env` symlink is needed.

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

Do not put secrets directly into launchd plists or process-compose YAML. Use
the root-owned refresh helper to turn `WORKSPACE_ENV` into the generated
runtime env file.

The generated env path should live outside user-writable directories, for
example:

```text
/var/db/uinaf/devbox-env/<identity>/workspace.env
```

If a workspace needs a project-local dotenv file, use an explicit symlink to a
workspace repo path such as `/Users/<user>/projects/<workspace>/.env`. The
link must stay under the target user's home, its basename must be `.env`, and
the workspace directory must already exist and ignore `.env` before the helper
creates the link.

The refresh helper logs live at `/var/log/uinaf-devbox-env-refresh.<identity>.*`
and should be root-owned mode `0640`.

Install the root-owned refresh helper with explicit local values:

```zsh
sudo ./scripts/secrets/install-env-refresh.sh \
  --identity example \
  --target-user example \
  --op-account example.1password.com \
  --op-vault example-devbox \
  --link-file /Users/example/projects/workspace/.env \
  --required-keys 'EXAMPLE_SERVICE_TOKEN'
```

Then install the service-account token at the path printed by the installer:

```zsh
op read 'op://<human-vault>/<service-account-token-item>/password' \
  | sudo ./scripts/secrets/install-op-token.sh --identity example
```

The token file must be root-owned and mode `0400` or `0600`. By default, the
helper reads `WORKSPACE_ENV` and writes env-shaped item fields into:

```text
/var/db/uinaf/devbox-env/<identity>/workspace.env
```

The generated file is owned by the target service user and mode `0400`.
Workspace-specific API keys may live there when the workspace needs them. The
helper does not block specific env names in generated output; use the root-owned
token file for the 1Password service-account token unless the devbox identity is
intentionally allowed to pass that token through its generated runtime env.

## Verification

Run the normal bootstrap check for each user:

```zsh
./scripts/verify/bootstrap.sh --profile devbox
```

Devbox Git config includes `/opt/homebrew` as a safe directory so both admin
users can operate on the shared Homebrew prefix without Git dubious-ownership
failures.

Run the devbox-specific boundary check for each devbox user:

```zsh
./scripts/verify/devbox-services.sh
```

That check verifies process-compose, secret-file modes, default shell token
exports, and the configured root-owned token file. Normal devbox users may not
be able to see the root-owned token file; that is expected.

Run the devbox security audit for each devbox user:

```zsh
./scripts/audit/devbox.sh
```

That audit is stricter than verification. It checks stale secret-looking
backups, generated env drift, Git/GitHub identity, SSH key permissions, GitHub
SSH auth, admin group drift, Tailscale health, and local service config.
Generated workspace env files may contain expected runtime credentials, so the
audit checks their boundary instead of secret-scanning their contents.

Treat prose audit output as sensitive. Maintained scanners can include matched
secret material when they report a verified leak, so use `--json` for remote
collection and summarize findings by detector type, file path, and line number.

If the audit reports that direct MagicDNS works but the system resolver is not
using Tailscale DNS, restart the Homebrew Tailscale daemon from a local admin
session:

```zsh
sudo launchctl kickstart -k system/homebrew.mxcl.tailscale
```

Then rerun `./scripts/audit/devbox.sh`. The repaired resolver should resolve
Tailscale short hostnames through normal system lookup, not only through direct
queries to `100.100.100.100`.

If the daemon restart does not restore resolver wiring, recreate the resolver
files explicitly:

```zsh
sudo mkdir -p /etc/resolver
printf 'nameserver 100.100.100.100\nsearch <tailnet>.ts.net\n' \
  | sudo tee /etc/resolver/search.tailscale >/dev/null
printf 'nameserver 100.100.100.100\n' \
  | sudo tee /etc/resolver/<tailnet>.ts.net >/dev/null
printf 'nameserver 100.100.100.100\n' \
  | sudo tee /etc/resolver/ts.net >/dev/null
sudo dscacheutil -flushcache
sudo killall -HUP mDNSResponder
```

For broad OS-level posture, run `./scripts/audit/host.sh`. It uses
Lynis as a maintained host scanner and keeps full reports out of the repo by
default.

For compliance-style OS posture, run `./scripts/audit/repo.sh` after
generating a macOS Security Compliance Project check-only script for the host's
macOS version. Start with check-only results and review exceptions before
applying any remediation outside this repo. See
[Security audits](security-audits.md) for the full audit model.
