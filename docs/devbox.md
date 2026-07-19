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
credentials, recovery material, and human SSH key material. A devbox identity
may also receive narrowly scoped operational credentials in Infisical when the
agent must use them unattended. Keep those credentials outside runtime env
bundles and retrieve them only at the command boundary. Devbox agent SSH key
material may live in Infisical under the same boundary.

When an agent task needs shared env, check the relevant Infisical project/path
first. Do not recreate workspace `.env` symlinks, devbox-env generated files,
token caches, or 1Password service-account refresh stacks.

For services and agents:

1. Create or choose the correct Infisical project and environment for the
   runtime.
2. Create a machine identity in the same Infisical organization and grant it
   access to that project/path.
3. Configure the devbox user once with
   `./scripts/secrets/configure-infisical-devbox.sh`.
4. Use Universal Auth to mint short-lived machine tokens at command time.
   Do not keep a human Infisical CLI session on agent devboxes.
5. Keep raw client secrets and access tokens out of shell startup, launchd
   plists, process-compose YAML, tracked files, and long-lived interactive
   shells.
6. Run the env-consuming runtime through
   `./scripts/secrets/infisical-devbox-run.sh -- <command>`. The runtime owns how
   it reads Infisical and sets itself up.
7. Keep any identity-specific Infisical project, environment, path, client ID,
   or client secret values out of this repo.

Infisical access tokens are short-lived. A devbox that must keep working across
future agent shells and reboots needs the Universal Auth client credentials in
owner-only local machine state. This is an intentional tradeoff: the
credentials are persistent on that Unix account, but they are not shell
exports, process-compose config, launchd config, tracked files, or generated
runtime dotenv refresh stacks.

One-time setup:

```sh
./scripts/secrets/configure-infisical-devbox.sh
```

The helper prompts locally for the Infisical domain, project ID, environment,
Universal Auth client ID, and Universal Auth client secret. Use the client ID
shown under the machine identity's Universal Auth method, not the machine
identity ID shown in the identity details panel. Humans should source those
values from their secret manager, usually 1Password or Infisical, and enter them
locally. Do not paste them into agent chat.

It writes non-secret selectors to `~/.config/uinaf/devbox.env` and machine
credentials to `~/.config/uinaf/infisical-machine.env`. Both files must be mode
`0600`. The helper refuses to continue when the Infisical CLI has an
authenticated human `user` session and verifies the machine identity can mint a
token before writing config. It does not persist secret paths; paths belong at
the command boundary.

Routine command-boundary use gives one child command a short-lived machine
token and the configured Infisical project selectors:

```sh
./scripts/secrets/infisical-devbox-run.sh -- <repo-owned-secret-command>
```

The child command receives `INFISICAL_TOKEN`, `INFISICAL_DOMAIN`,
`INFISICAL_PROJECT_ID`, and `INFISICAL_ENV`. If the caller sets
`INFISICAL_SECRET_PATH`, the runner forwards it too. Dotfiles does not render
app env, generate runtime dotenv files, or know another repo's secret path.

Repo-local setup example:

```sh
INFISICAL_SECRET_PATH=/example-repo/runtime \
  ~/projects/uinaf/dotfiles/scripts/secrets/infisical-devbox-run.sh -- \
  make secrets-setup
```

The target repo owns `make secrets-setup`: it may run `infisical export`, use
`infisical run`, write an ignored `0600` local file, or avoid disk entirely.

OpenClaw-shaped example:

```sh
INFISICAL_SECRET_PATH=/example-devbox/openclaw-env \
  ~/projects/uinaf/dotfiles/scripts/secrets/infisical-devbox-run.sh -- \
  openclaw <env-render-or-run-command>
```

The real OpenClaw path and command belong in the workspace or OpenClaw docs,
not in this public repo.

For unattended elevated maintenance, store only an ASCII-armored age ciphertext
as `SUDO_PASSWORD_AGE` in the identity's Infisical folder. Never store the
plaintext password in Infisical. Each host keeps a dedicated age identity at
`~/.config/uinaf/sudo-age-identity.txt` with mode `0600`; its private value is
recovery material and may be backed up to the matching human 1Password item.
Create or verify the local identity and print its public recipient with:

```sh
./scripts/secrets/configure-infisical-devbox-sudo.sh
```

Encrypt the password to that recipient without writing plaintext to a regular
file, import the ciphertext as `SUDO_PASSWORD_AGE`, and put the identity-specific
folder selector in owner-only local config as `INFISICAL_SUDO_SECRET_PATH`.
The repo-owned sealing command is:

```sh
<concealed-password-command> | ./scripts/secrets/infisical-devbox-sudo-seal.sh
```

The left side must emit only the password and must not place it in argv or shell
history. The sealing helper performs a local decrypt/compare and refuses a
remaining plaintext `SUDO_PASSWORD` secret.
Then run:

```sh
./scripts/secrets/infisical-devbox-sudo.sh -- <non-interactive-command>
```

Commands such as Homebrew must remain unprivileged but may invoke sudo for a
narrow application-bundle ownership step. Run those through nested mode so the
child command receives the fixed askpass boundary without running the whole
tool as root. Run it from a terminal; remote automation must allocate a PTY so
the child's sudo calls can reuse the authenticated ticket:

```sh
./scripts/secrets/infisical-devbox-sudo.sh --nested -- \
  brew upgrade --cask <cask>
```

The wrapper mints a short-lived machine token and writes only ciphertext to an
owner-only temporary file. The fixed askpass helper decrypts that ciphertext on
demand each time `sudo -k -A` requests authentication, so retries do not hang
and the wrapper or long-running command never retains plaintext. The command
keeps the caller's original stdin, including when authentication is cached or
the command is covered by `NOPASSWD`. The wrapper does not export the password,
write plaintext to a regular local file, or mix it into application env.
Nested mode gives the unprivileged child access to that same temporary askpass
boundary for the duration of the command, which carries the same arbitrary-root
delegation as direct mode.

Project-level identities may be able to read sibling ciphertext on Infisical
plans without path-scoped RBAC. That is not a plaintext disclosure: each
ciphertext is encrypted to a different host-local age identity. Prove sibling
decryption fails. Treat write access to sibling ciphertext as a denial-of-service
risk and keep the 1Password recovery copy current.

This is intentional arbitrary-root delegation, not an approval gate or command
allowlist. Any process running as the devbox user can read its machine identity
config and invoke the wrapper. Use it only for dedicated, trusted agent
accounts where compromise of that Unix identity is accepted as host-root
compromise. Use root-owned allowlisted helpers or narrow `sudoers` rules when a
runtime must not receive arbitrary root.

Small `AGENTS.md` snippet for a repo that frequently needs runtime secrets:

```md
## Secrets

On agent devboxes, use Infisical through the dotfiles runner:

`INFISICAL_SECRET_PATH=/this-repo/runtime ~/projects/uinaf/dotfiles/scripts/secrets/infisical-devbox-run.sh -- make secrets-setup`

Do not use 1Password, workspace `.env` symlinks, or committed/generated secret
files for agent runtime env.
```

Do not add dotfiles scripts that render another repo's secrets. If a consumer
repo needs a better secret setup flow, add the wrapper to that repo.

If setup fails with `Invalid credentials`, check that the ID came from the
Universal Auth method. The machine identity ID in the details panel is not a
Universal Auth client ID and cannot mint a token.

## Agent SSH Key Storage

Devbox agent SSH keys may be stored as Infisical secrets. This keeps the key in
the same human-plus-agent sharing system as runtime env while avoiding
1Password service-account plumbing in agents.

Use this shape:

1. Store the private key under the devbox or agent secret boundary that needs
   it.
2. Store the public key, fingerprint, and key type beside it.
3. Store a base64 copy when a shell or CLI path needs a single-line value.
4. Grant the machine identity only the project/path it needs.
5. Retrieve the key only into the command environment or an owner-only local
   key file, then set mode `0600`.

The retrieval command shape is:

```sh
SSH_PRIVATE_KEY_B64_SECRET=EXAMPLE_SSH_PRIVATE_KEY_B64
INFISICAL_SSH_SECRET_PATH=/example-devbox/ssh
SSH_IDENTITY_FILE="$HOME/.ssh/example"

INFISICAL_SECRET_PATH="$INFISICAL_SSH_SECRET_PATH" \
SSH_PRIVATE_KEY_B64_SECRET="$SSH_PRIVATE_KEY_B64_SECRET" \
  ./scripts/secrets/infisical-devbox-run.sh -- \
  sh -c '
    infisical secrets get "$SSH_PRIVATE_KEY_B64_SECRET" \
      --domain "$INFISICAL_DOMAIN" \
      --token "$INFISICAL_TOKEN" \
      --projectId "$INFISICAL_PROJECT_ID" \
      --env "$INFISICAL_ENV" \
      --path "$INFISICAL_SECRET_PATH" \
      --plain \
      --silent
  ' | base64 --decode > "$SSH_IDENTITY_FILE"

chmod 600 "$SSH_IDENTITY_FILE"
ssh-keygen -y -f "$SSH_IDENTITY_FILE" | ssh-keygen -lf -
```

Verify by fingerprint only. Do not print private keys, paste key values into
chat, commit key material, or keep Infisical client secrets in shell startup,
launchd, process-compose, tracked files, or long-lived shells.

Before treating a devbox as agent-ready:

1. Verify the machine identity can list or export the intended project/path.
2. Verify `infisical login status --domain https://eu.infisical.com/api` has no
   authenticated `user` session.
3. Verify no default shell exports Infisical tokens or machine credentials.

`./scripts/verify/devbox-services.sh` checks the Infisical CLI, owner-only
config modes, and machine identity token minting. Set
`INFISICAL_SECRET_PATH=/some/path` only when you want that check to also prove
access to a specific command-boundary path. When the local config contains
`INFISICAL_SUDO_SECRET_PATH`, the check also proves that non-empty
`SUDO_PASSWORD_AGE`, the local mode-`0600` age identity, and the trusted age
binary are available without printing secret material. A missing persistent machine
identity config fails by default. Set `INFISICAL_MACHINE_AUTH_REQUIRED=0` only
for repo-local smoke checks on a machine that is not acting as an agent devbox.

## Secret Topology

Use secret-manager projects and vaults to model capability boundaries. A
boundary should answer "which runtime needs this secret?" rather than "which
human knows about this project?"

Use this generic split:

| Context | Vault | Access |
| --- | --- | --- |
| Human operations | 1Password and Infisical | Humans only. |
| Shared env | Infisical `<context>` project | Humans and approved agent identities. |
| Devbox agents | Infisical identity scoped to the devbox user | Env and SSH key material for that devbox identity only. |
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
`~/.ssh/github.config` when the signing key is a local path. That override uses
the local key file directly and sets `IdentityAgent none` for GitHub only.

## Local Contract

Each devbox user should have a local config file outside Git:

```sh
DEVBOX_USER=example
PROCESS_COMPOSE_SOCKET="/Users/example/.local/run/process-compose.sock"
INFISICAL_DOMAIN=https://eu.infisical.com/api
INFISICAL_PROJECT_ID=example-project-id
INFISICAL_ENV=dev
```

The file should be mode `0600`. Persistent machine credentials live separately
in `~/.config/uinaf/infisical-machine.env`, also mode `0600`:

```sh
INFISICAL_CLIENT_ID=...
INFISICAL_CLIENT_SECRET=...
```

Keep both files out of Git. Do not create repo-local workspace `.env` symlinks
for agent runtime env.

If a devbox identity does not run process-compose, set
`PROCESS_COMPOSE_ENABLED=0` in its local config so verification does not
accidentally query another user's supervisor.

## Supervisor

Use process-compose as the per-user supervisor for always-on agent services
when the identity needs it. Launchd should start process-compose;
process-compose should own service restart policy, logs, health checks, and
one-shot tasks.

On a shared headless Mac, a user's `~/Library/LaunchAgents` jobs start only
when that user owns a GUI login session. If another identity owns automatic
login, migrate the required background services to root-owned system
LaunchDaemons that use `UserName` to drop privileges back to the service
identity:

```zsh
sudo ./scripts/bootstrap/install-devbox-service-daemons.sh \
  --user agent-user \
  --process-compose \
  --openclaw \
  --healthd
```

The installer retires the equivalent per-user LaunchAgents only after the
system jobs load successfully. For healthd, it also completes one check cycle
before retiring a same-user legacy LaunchAgent. Run selected services one at a
time when migrating production machines so failures stay isolated.

Healthd may run directly under launchd when it is the fleet monitor; it does
not need an extra process-compose layer. Verify boot-independent service
definitions without changing them:

```zsh
./scripts/bootstrap/install-devbox-service-daemons.sh \
  --check \
  --user agent-user \
  --process-compose \
  --openclaw \
  --healthd
```

A user that needs only the existing `~/.local/bin/colima-ensure` boot task can
use `--colima` instead of running a process-compose supervisor solely for that
one-shot command.

Keep the system jobs root-owned and mode `0644`. They may name owner-only env
files and wrappers, but must not embed secret values in the plist. The service
processes still run as the selected Unix identity.

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

Devbox Git config includes `/opt/homebrew` as a safe directory so local admin
users can operate on the shared Homebrew prefix without Git dubious-ownership
failures.

Run the devbox-specific boundary check for each devbox user:

```zsh
./scripts/verify/devbox-services.sh
```

That check verifies process-compose, default shell auth exports, Infisical CLI
availability, persistent machine credential file permissions, and configured
machine identity access. It also fails if the Infisical CLI has an
authenticated human `user` session on the devbox.

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
