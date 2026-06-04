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
- Infisical workspace/project auth and service tokens
- workspace env values and local service state
- process-compose ports when they are identity-specific
- Codex auth, trusted paths, sessions, and agent-rule symlinks

## Secret Model

Environment variables are not a secret boundary. Anything running in that
process tree can read them.

Humans use both 1Password and Infisical. Agents use Infisical only for
secrets/env access. 1Password remains the human/manual vault for account
credentials, recovery material, human SSH key material, and other secrets that
should not be ambiently available to agents. Devbox agent SSH key material may
live in Infisical under the devbox boundary when the agent needs to retrieve or
write it.

When an agent task needs shared env, check the relevant Infisical project/path
first. Do not recreate workspace `.env` symlinks, devbox-env generated files,
or 1Password service-account refresh stacks.

For services and agents:

1. Create or choose the correct Infisical project, environment, and folder path
   for the runtime.
2. Create a machine identity in the same Infisical organization and grant it
   access to that project/path.
3. Use Universal Auth to mint a short-lived machine token at command time.
   Do not keep a human Infisical CLI session on agent devboxes.
4. Keep raw client secrets and access tokens out of shell startup, launchd
   plists, process-compose YAML, tracked files, and long-lived interactive
   shells.
5. Prefer `infisical run -- <command>` or `infisical export --token ...` at
   the process boundary instead of repo-managed generated dotenv files.
6. Keep any identity-specific Infisical project, environment, path, client ID,
   or client secret values in the operator's secret manager or a deliberate
   owner-only local handoff, not in this repo.

The command shape is:

```sh
INFISICAL_TOKEN="$(
  infisical login \
    --domain https://eu.infisical.com/api \
    --method=universal-auth \
    --client-id "$INFISICAL_CLIENT_ID" \
    --client-secret "$INFISICAL_CLIENT_SECRET" \
    --plain \
    --silent
)"

infisical export \
  --domain https://eu.infisical.com/api \
  --token "$INFISICAL_TOKEN" \
  --projectId "$INFISICAL_PROJECT_ID" \
  --env "$INFISICAL_ENV" \
  --path "$INFISICAL_SECRET_PATH" \
  --format dotenv \
  --output-file "$HOME/.openclaw/.env" \
  --silent

unset INFISICAL_TOKEN
```

For non-OpenClaw services, replace the output file with the runtime-specific
file or use `infisical run --token "$INFISICAL_TOKEN" -- <command>`.

Do not create hidden helper scripts or saved machine-credential files as part
of this repo's devbox contract unless a separate setup decision explicitly adds
them. If unattended refresh becomes necessary, document and verify that
mechanism first.

Before treating a devbox as agent-ready:

1. Verify the machine identity can list or export the intended project/path.
2. Verify `infisical login status --domain https://eu.infisical.com/api` has no
   authenticated `user` session.
3. Verify no default shell exports `INFISICAL_TOKEN`.
4. Verify runtime dotenv files are owner-only and are not workspace symlinks.

## Secret Topology

Use secret-manager projects and vaults to model capability boundaries. A
boundary should answer "which runtime needs this secret?" rather than "which
human knows about this project?"

Use this generic split:

| Context | Vault | Access |
| --- | --- | --- |
| Human operations | 1Password and Infisical | Humans only. |
| Shared env | Infisical `<context>` project | Humans and approved agent identities. |
| Devbox agents | Infisical identity scoped to the devbox user | Env and agent key material for that devbox identity only. |
| CI | `<context>-ci` | GitHub Actions or the relevant CI runtime only. |
| Shared CI lane | `<lane>-ci` | Only the CI jobs for that lane. |

Do not share service tokens across these boundaries. CI, devbox agents, and
humans are different runtimes and should get different credentials even when
they work on related projects. Store bootstrap/recovery credentials where
humans can rotate them, not inside the same runtime scope the credential reads.

## Identity Boundaries

Shared devboxes may host multiple agent identities. Keep their Unix users, Git
identity, GitHub auth, SSH keys, Codex/Claude config, trusted project paths,
workspaces, and Infisical access separate.

The goal is to avoid ambient cross-context access. A compromised package,
agent session, or service in one identity should not automatically get another
identity's Slack, GitHub, CI, or Infisical capabilities.

If an identity needs access outside its normal context for a specific task,
grant it explicitly and temporarily, then remove that access after the task.

For GitHub, devbox repos should use SSH remotes. A human should provision the
per-user GitHub key into an owner-only local key file during bootstrap.
`configure-git.sh --profile devbox` writes a `Host github.com` override in
`~/.ssh/config.local` when the signing key is a local path. That override uses
the local key file directly and sets `IdentityAgent none` for GitHub only.

## Local Contract

Each devbox user should have a local config file outside Git:

```sh
UINAF_DEVBOX_USER=example
UINAF_PROCESS_COMPOSE_SOCKET="/Users/example/.local/run/process-compose.sock"
```

The file should be mode `0600`. Keep Infisical selectors and credentials out
of this repo. Do not create repo-local workspace `.env` symlinks for
agent/OpenClaw runtime env.

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
Infisical at the command boundary for workspace/app env.

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

That check verifies process-compose, default shell token exports, and Infisical
CLI availability. It also fails if the Infisical CLI has an authenticated human
`user` session on the devbox.

Run the devbox security audit for each devbox user:

```zsh
./scripts/audit/devbox.sh
```

That audit is stricter than verification. It checks stale secret-looking
backups, Git/GitHub identity, SSH key permissions, GitHub SSH auth, admin group
drift, Tailscale health, and local service config.

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
