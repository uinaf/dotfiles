# Devbox Setup

- Start with [Bootstrap](bootstrap.md) and [Identity provisioning](identities.md).
- Isolate each identity in its own Unix user, home, credentials, and service state.
- `personal-devbox` adds personal tools and gateway routing.

## Local Configuration

Optional per-user settings live in `~/.config/dotfiles/devbox.env`, mode `0600`:

```sh
DEVBOX_USER=example
```

- Resolve SOPS secrets only in the consuming process. Keep plaintext tokens out
  of shell startup, plists, and supervisor configuration.
- Human GitHub access uses personal SSH keys; unattended access should use
  repository-scoped GitHub App tokens over HTTPS and a separate commit identity.

## Sudo Without a Plaintext Password File

Store `SUDO_PASSWORD_AGE` in the user's SOPS payload. Encrypt that inner value to
a dedicated sudo age identity. Add these paths to the owner-only local config:

```sh
SOPS_SUDO_SECRET_FILE="$HOME/projects/example/vault/secrets/identity/user-sudo.sops.json"
SUDO_AGE_IDENTITY_FILE="$HOME/.config/dotfiles/sudo-age-identity.txt"
```

Run a fixed command, or leave the child unprivileged while allowing its own sudo
calls:

```zsh
./scripts/secrets/sops-devbox-sudo.ts -- /bin/launchctl kickstart -k system/example.service
./scripts/secrets/sops-devbox-sudo.ts --nested -- /path/to/service-restart.sh
```

The password is decrypted in the askpass process. A narrow sudoers allowlist
remains the authorization boundary.

## Opt-In Coding LLM Gateway

Personal profiles require `~/.config/dotfiles/llm-gateway.json`, mode `0600`.
Standard profiles can enroll explicitly. Obtain resolved credentials from the
owning private system and use the version 3 schema:

```json
{
  "version": 3,
  "credentials": {
    "gatewai": "<resolved Gatewai key>",
    "bifrost": "<resolved Bifrost key>"
  },
  "gatewaiBaseUrl": "https://gatewai.example/v1",
  "bifrostBaseUrl": "https://bifrost.example/v1"
}
```

| Optional field | Use |
| --- | --- |
| `cursorAgentBin` + `credentials.cursor` | Configure together; the binary must be Cursor's versioned vendor executable, not a managed launcher. |
| `grokBin` | Absolute path to the Grok executable. |
| `preservedLogins` | Client names whose saved logins must survive retirement: `codex`, `claude`, `cursor`, `grok`. |

- Gatewai: Codex, Claude, optional Grok.
- Bifrost: OpenCode and Pi. Cursor uses its own API key.
- Credentials stay in owner-only configuration or client stores.

```zsh
./scripts/bootstrap/configure-llm-gateway.ts
./scripts/bootstrap/configure-llm-gateway.ts --check
./scripts/bootstrap/configure-bifrost-clients.ts
./scripts/bootstrap/configure-bifrost-clients.ts --check
```

- Explicit enrollment and `./dotfiles maintain` preserve saved logins.
- Personal `./dotfiles apply` retires them, respecting `preservedLogins`.
- To retire after checking explicit enrollment:

```zsh
./scripts/bootstrap/configure-llm-gateway.ts --retire-auth
./scripts/bootstrap/configure-llm-gateway.ts --check
```

### Client Troubleshooting

- **Codex:** `codex login status` can report `Not logged in` with working
  command-based gateway auth. A live check is
  `echo ok | codex exec --ephemeral --skip-git-repo-check -` (uses provider quota).
  Harnesses using `--ignore-user-config` must launch
  `~/.local/libexec/dotfiles/codex-gatewai` to retain gateway routing.
- **Claude:** enrollment refuses conflicting `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, Bedrock, or Vertex settings. Resolve those deliberately
  before retrying.
- **Cursor:** `cursor-agent` resolves from `~/.local/libexec/dotfiles/bin`, which
  is fronted on `PATH` and never written by the vendor. Cursor self-updates
  replace the commands in `~/.local/bin`; the stable launcher follows the vendor
  executable. Point integrations that take an explicit path at
  `~/.local/libexec/dotfiles/cursor-agent-api`. It blocks browser login/logout
  and checks API-key health through `status`, `whoami`, and `about`. `--version`
  and `--help` pass through unauthenticated, so only `--check` proves which
  launcher `PATH` reaches.
- **`agent`:** ambiguous and never resolved by dotfiles. Both Cursor and the Grok
  cask install it; Homebrew wins on `PATH`. Call `cursor-agent` or `grok`.
- **OpenCode/Pi:** `configure-bifrost-clients.ts` converges the Bifrost catalog
  and credentials. OpenCode enables only the `bifrost` provider.

### Rollback

```zsh
./scripts/bootstrap/configure-llm-gateway.ts --rollback
```

- Restores saved client configuration and Cursor symlinks; removes helpers.
- Deleted logins cannot be restored. Authenticate retired clients again before
  direct use.

## System Services

Install Colima's boot service from an authorized administrator account for the
user who owns Colima:

```zsh
sudo ./scripts/darwin/bootstrap/install-devbox-service-daemons.ts --user example --colima
sudo ./scripts/darwin/bootstrap/install-devbox-service-daemons.ts --user example --colima --check
```

- Root-owned LaunchDaemon, mode `0644`, running as the target user.
- Retire competing user LaunchAgents before installation.
- Reference owner-only wrappers or files; never embed secrets.

The `devbox` profiles install the T3 Code background service as the target
user through the `install-t3-service` step (`t3 service install --base-dir
~/.t3`, with the CLI pinned in the mise template) when its unit is absent.
Only an explicit `./dotfiles apply` installs it; unattended maintenance never
adds a background service. T3 owns later updates and `./dotfiles check`
proves the unit exists. Inspect it with:

```zsh
npx t3@latest service status
```

On macOS keep the user logged in and the Mac awake; the LaunchAgent stops at
logout. Installing over SSH for a user with no GUI session writes the
LaunchAgent but cannot start it; the step reports the deferred start and the
service comes up at that user's next login, so a green maintenance run does
not by itself prove the service is running. On Linux the systemd user service needs lingering, which an
administrator enables once with `sudo loginctl enable-linger <user>`. Keep
`--base-dir` stable across updates; see the upstream
[background service guide](https://github.com/pingdotgg/t3code/blob/main/docs/user/background-service.md).

## Software Updates and Cleanup

Use the [shared Homebrew wrapper](bootstrap.md#shared-homebrew-updates) as the
prefix owner. [Headless update enrollment](software-updates.md#headless-devbox-updates)
runs shared packages and per-user updates without a GUI login.

[Host hygiene](software-updates.md#host-hygiene) runs when due during updates:

```zsh
mise run maintenance:hygiene # preview
mise run maintenance:clean   # apply with the updater idle
```

## Verification

Run as the intended Unix user:

```zsh
./dotfiles check devbox # use personal-devbox for that profile
./scripts/darwin/verify/devbox-services.ts
mise run audit devbox --format json
```

Audit prose can contain secrets. Collect JSON and report detector, path, and
line without copying matched values.
