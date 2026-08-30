# Devbox Setup

Devbox automation keeps dedicated Unix users reproducible without making
secrets or identities part of the public dotfiles repository.

- Personal-devbox uses the devbox operational contract with headless personal
  tools and skills.
- The assistant profile reuses the same Unix-user and service boundaries without
  inheriting the coding toolchain or a human Git identity.

Credentials and lifecycle live in [Identity provisioning](identities.md).

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

- Each identity gets its own Unix user, home directory, Git identity, age
  identity, agent homes, workspaces, and service state.
- Provision GitHub and outbound SSH capabilities only when that identity needs
  them.
- Grant cross-context access explicitly and temporarily.

## Secret Model

- SOPS ciphertext belongs in a private capability-scoped vault repository.
- Each Unix identity has a dedicated age identity at the standard SOPS path,
  with the private key mode `0600` and parent directory mode `0700`.
- Back that identity up through an approved human recovery system before
  encrypting live secrets.
- Repository access grants ciphertext access; the SOPS recipient list grants
  decryption. Both are required.
- Product repos should consume env vars, owner-only prepared files, or CI
  secrets instead of containing secret-manager clients.

Provision or verify the age identity with the commands in
[Identity provisioning](identities.md#sops-age-identity).

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
node scripts/secrets/sops-devbox-sudo.ts -- /bin/launchctl kickstart -k system/example.service
node scripts/secrets/sops-devbox-sudo.ts --nested -- ./scripts/service/restart.sh
```

The password exists only in the askpass process. Keep the sudoers allowlist as
the primary authorization boundary and use the nested mode only when the child
command itself must stay unprivileged.

## GitHub and SSH

- Human devbox users may keep their own GitHub account and SSH signing key.
- Unattended identities should use a repository-scoped GitHub App installation
  token and a separate commit identity.
- Git author metadata is not an authorization mechanism. HTTPS push and GitHub
  API operations use the short-lived App token.
- Devbox Git repositories normally use SSH remotes for human identities.
- `configure-git.ts --profile devbox` (or `personal-devbox`) writes a
  `Host github.com` override in `~/.ssh/github.config` when the signing key is a
  local path.

## Local Contract

Optional per-user service settings live outside Git at
`~/.config/dotfiles/devbox.env` with mode `0600`:

```sh
DEVBOX_USER=example
```

Do not create broad workspace env bundles or load secrets in shell startup.

## Opt-In Coding LLM Gateway

Developer-profile users may route Codex and Claude Code through a private LLM
gateway and run Cursor Agent with an identity-owned API key.

- Generic developer profiles opt in with an owner-only local configuration
  file. Personal profiles require that file and apply the gateway during normal
  setup.
- Personal setup retires saved vendor sessions automatically and idempotently.
- It does not change the assistant profile.
- It stores no secrets in shell startup, Codex configuration, or Claude
  settings. Resolved credentials live only in the owner-only local gateway
  configuration and client-native owner-only stores.

Create `~/.config/dotfiles/llm-gateway.json` with mode `0600`:

```json
{
  "version": 3,
  "credentials": {
    "gatewai": "<resolved Gatewai key>",
    "bifrost": "<resolved Bifrost key>",
    "cursor": "<resolved Cursor key>"
  },
  "gatewaiBaseUrl": "https://gatewai.example/v1",
  "bifrostBaseUrl": "https://bifrost.example/v1",
  "cursorAgentBin": "/Users/example/.local/share/cursor-agent/versions/2026.08.11-e8db854/cursor-agent",
  "grokBin": "/opt/homebrew/bin/grok"
}
```

`credentials.gatewai` and `credentials.bifrost` are required. Configure
`credentials.cursor` only with `cursorAgentBin`. An optional
`preservedLogins` array (values `codex`, `claude`, `cursor`, `grok`) declares
host-local vendor logins that retirement and `--check` must leave alone; use
it for a deliberately kept login instead of tolerating a failing check. The values are already-resolved
opaque strings: this repository does not know or require their source. Both
`cursorAgentBin` and `grokBin` are optional. The configurators route Codex,
Claude, and Grok through Gatewai, Cursor through its own API, and OpenCode and
Pi through Bifrost. Other clients can call the installed credential helper
with `bifrost`. The gateway configurator then:

- installs owner-only process helpers
- backs up the current Codex and Claude settings once
- uses Codex's native atomic config writer to select a command-authenticated
  Responses provider

```bash
./scripts/bootstrap/configure-llm-gateway.ts
./scripts/bootstrap/configure-llm-gateway.ts --check
./scripts/bootstrap/configure-bifrost-clients.ts
./scripts/bootstrap/configure-bifrost-clients.ts --check
```

- The first enrollment keeps any saved Codex login intact.
- Generic developer profiles can accept the rollback path before running the
  separate retirement step.
- Personal setup runs the retirement step automatically and idempotently.
- Remove the saved login only in the separate, explicit auth-retirement step
  after the gateway and rollback path are accepted.

After the gateway has been accepted, retire the three coding-client login
caches through their supported logout commands and remove Codex's obsolete
login-method restriction:

```bash
./scripts/bootstrap/configure-llm-gateway.ts --retire-auth
./scripts/bootstrap/configure-llm-gateway.ts --check
```

Retirement is intentionally separate from enrollment:

- It is idempotent and keeps the owner-only gateway configuration in place.
- It does not touch GitHub, SSH, OpenClaw, or connector credentials.
- Rollback after retirement restores the pre-gateway client configuration but
  cannot restore deleted login credentials. Authenticate each coding client
  again before direct use.
- A complete developer-profile `install.ts` run preserves gateway routing and
  removes any legacy Codex login-method restriction.
- Personal setup asks the installed credential helper for the device-scoped
  Bifrost key, writes it to OpenCode's owner-only `bifrost` auth slot, and sets
  `enabled_providers` to only `bifrost`. It converges the same six-model catalog
  in OpenCode and Pi, including context and output limits. Other settings,
  providers, and inactive credentials remain untouched; direct `opencode` and
  `opencode-go` auth slots remain absent.

Codex after retirement:

- `codex login status` reports `Not logged in` by design: authentication flows
  through the `model_providers.*.auth` credential command in `config.toml`,
  not a saved login or `OPENAI_API_KEY`.
- The Gatewai provider sends Codex's `X-OpenAI-Actor-Authorization: local-proxy`
  compatibility marker so the client exposes its local image-generation tool
  while the credential command remains the authentication boundary.
- The Gatewai provider enables Codex's persistent Responses WebSocket
  transport to the proxy. Native upstream reuse also requires WebSockets on
  the proxy's selected Codex credential.
- Do not diagnose a "missing" Codex credential from `codex login status` or
  environment variables. Verify with a live call instead:
  `echo ok | codex exec --ephemeral --skip-git-repo-check -`.
- Child processes that launch `codex` inherit this configuration as long as
  they preserve `HOME`/`CODEX_HOME`. Harnesses that pass
  `--ignore-user-config` drop the gateway provider from `config.toml`; for
  those, point the harness at the installed
  `~/.local/libexec/dotfiles/codex-gatewai` launcher (for example
  `CODEX_BIN=~/.local/libexec/dotfiles/codex-gatewai`). It re-injects the
  gateway provider as CLI `-c` overrides, resolves its paths from its own
  install location so a redirected `HOME` cannot break it, and keeps secrets
  out of the environment and argument list.

Claude Code:

- Receives `ANTHROPIC_BASE_URL` and `apiKeyHelper` in its existing user
  settings; every unrelated setting remains in place.
- Keeps its saved Claude login; enrollment alone does not remove it.
- Fails enrollment when the settings already define `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, Bedrock, or Vertex selection, because those values
  take precedence over the gateway helper. Remove that conflict deliberately
  before enrollment instead of silently routing around it.

Cursor commands:

- The stable API-key launcher lives at
  `~/.local/libexec/dotfiles/cursor-agent-api`. Point clients that accept an
  explicit binary path, including T3 Code, at that absolute path.
- The configurator records the exact installer-managed symlink targets, then
  replaces `~/.local/bin/cursor-agent` and `~/.local/bin/agent` with the API-key
  launcher. Cursor can replace those paths again during a self-update, so they
  are compatibility commands rather than the durable integration point.
- Managed login and non-interactive zsh shells include `~/.local/bin` in `PATH`,
  while interactive zsh aliases `cursor-agent` to the stable launcher.
- `cursorAgentBin` must therefore point to Cursor's versioned vendor executable,
  never one of those launcher paths.
- The standalone `~/.local/bin/cursor-agent-api` path remains available for
  compatibility.
- When Cursor self-updates, the stable launcher follows the new canonical
  vendor symlink while preserving API-key authentication. A later managed
  installer run reapplies the compatibility commands.
- The launcher uses Cursor's in-memory credential store so API-key checks do
  not recreate saved login state.

Launcher behavior:

- Blocks `login` and `logout` while enabled, so a help or diagnostic command
  cannot start browser authentication.
- Reports API-key health through `status`, `whoami`, and `about` after a provider
  model check, including a synthetic `api-key@local` identity for tools that
  parse `agent about`.
- Acknowledges ACP `authenticate` locally, so clients that always send
  `cursor_login` do not start a browser flow.

Grok Build:

- When `grokBin` is configured, the normal `grok` command uses Gatewai's
  OpenAI-compatible model catalog and the command-backed gateway bearer. The
  configurator backs up `~/.grok/config.toml` and `~/.grok/auth.json` before
  selecting the gateway, preserves unrelated Grok settings, and never calls
  `grok logout`. Rollback restores the exact saved config and SpaceXAI session.

Rollback restores the exact pre-enrollment Codex config, Claude settings, and
Cursor command symlinks, then removes the helpers. Saved coding login state is
untouched unless the separate `--retire-auth` operation was run:

```bash
./scripts/bootstrap/configure-llm-gateway.ts --rollback
```

## System Services

Install selected boot services from an authorized administrator account. The
installer creates root-owned system LaunchDaemons that drop privileges to the
target user.

For an OpenClaw workload, pass its user-owned executable wrapper and unique
gateway port:

```zsh
sudo node ./scripts/bootstrap/install-devbox-service-daemons.ts \
  --user example \
  --openclaw \
  --openclaw-wrapper /Users/example/.local/bin/openclaw-wrapper \
  --openclaw-port 18789 \
  --allow-openclaw-restart
```

For a headless T3 Code server, pin the exact npm version and the workspace used
for project and skill discovery:

```zsh
sudo node ./scripts/bootstrap/install-devbox-service-daemons.ts \
  --user example \
  --t3-code \
  --t3-version 0.0.35 \
  --t3-working-directory /Users/example/projects/example/workspace
```

After updating T3 Code on a workstation, sync its exact version to a devbox
with the portable workstation-side command:

```zsh
./scripts/bootstrap/sync-devbox-t3-server.ts \
  --host example@example-devbox
```

Pass `--version t3@<exact-version>` to override workstation app
detection. The sync command sends the tracked installer sources through SSH,
uses the remote user's home as the server working directory, and leaves no
remote bundle behind. It requires an explicit SSH user and host; it never
discovers or fans out to machines implicitly.

Inspect the same contract without changing either machine:

```zsh
./scripts/verify/t3-server-version.ts \
  --host example@example-devbox
```

The inspection writes one JSON object. `status` is `clean` when the versions
match and the service is loaded and healthy, `attention` for version or runtime
drift, and `incomplete` when workstation detection, SSH transport, or the
remote service structure cannot be established. Completed inspections exit
`0`, including drift; incomplete inspections exit `1`.

- `--allow-openclaw-restart` grants that user passwordless restart of only its
  exact OpenClaw system job, not general launchctl or sudo access.
- Use `--colima` only when that target user owns the service.
- T3 Code versions are installed side by side under
  `~/.local/share/t3-code/service/`; the plist pins the selected package and
  the target user's resolved Node executable.
- On npm 12 or newer, T3 dependencies install with lifecycle scripts disabled.
  The installer version-pins and rebuilds only `msgpackr-extract` and
  `node-pty`; any additional install-script dependency fails the update.
- Use `--check` with the selected service flags for a non-mutating contract
  check.
- System LaunchDaemons must be root-owned and mode `0644`.
- They may reference owner-only files and wrappers but must never embed secret
  values.
- Retire a competing user LaunchAgent before installing a system service for the
  same process.

## Verification

Run each check as the intended Unix identity:

```bash
./dotfiles check devbox
./scripts/verify/devbox-services.ts
mise run audit devbox --format json
```

Use `./dotfiles check personal-devbox` for the bootstrap check on an
owner-operated personal devbox. The service verification and audit commands
are unchanged.

| Gate | Checks |
| --- | --- |
| `./dotfiles check <profile>` | Selected profile packages and shared config |
| `./scripts/verify/devbox-services.ts` | Age identity, local config, and launchd boundary |
| `mise run audit devbox` | Stale secret-looking files, Git and GitHub identity, SSH permissions, project privacy, Tailscale health, and local service state |

Treat prose audit output as sensitive because scanners may include matched
material. Prefer `--json` for remote collection and summarize findings by
detector, path, and line number.
