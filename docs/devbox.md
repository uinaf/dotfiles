# Devbox Setup

- Start with [Bootstrap](bootstrap.md) and [Identity provisioning](identities.md).
- Isolate each identity in its own Unix user, home, credentials, and service state.

## Photos Analysis on macOS

Dotfiles apply disables `com.apple.photoanalysisd` for the current user on
macOS `devbox` and `personal-devbox` profiles. Existing analysis processes may
remain until logout. Workstation and developer profiles leave the setting alone.

This stops Photos background analysis, not iCloud Photos syncing, and deletes no
photos. Disable syncing separately in System Settings → Apple Account → iCloud
→ Photos → Sync this Mac. Other media and photo-library services remain enabled.

After switching away from a devbox profile, restore analysis explicitly if wanted:

```sh
launchctl enable gui/$(id -u)/com.apple.photoanalysisd
```

## Local Configuration

Optional per-user settings live in `~/.config/dotfiles/devbox.env`, mode `0600`:

```sh
DEVBOX_USER=example
T3_SERVICE=1
```

`T3_SERVICE=1` opts the user into the
[T3 Code background service](#system-services); a devbox identity reached only
through the desktop app's SSH launcher leaves it out.

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
./identity/sops-devbox-sudo.ts -- /bin/launchctl kickstart -k system/example.service
./identity/sops-devbox-sudo.ts --nested -- /path/to/service-restart.sh
```

The password is decrypted in the askpass process. A narrow sudoers allowlist
remains the authorization boundary.

## Opt-In Coding LLM Gateway

Personal profiles require `~/.config/dotfiles/llm-gateway.json`, mode `0600`.
Standard profiles can enroll explicitly. Obtain resolved credentials from the
owning private system. Start with this example and replace the credentials
and URLs:

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

[`GatewayShape` and `parseGatewayConfig`](../agents/gateway/gateway-config.ts)
own optional fields and validation. For Cursor, pair its API key with the
versioned vendor executable in `cursorAgentBin`; using the managed launcher
would recurse. Credentials stay in owner-only configuration or client stores.

```zsh
./bootstrap/configure-llm-gateway.ts
./bootstrap/configure-llm-gateway.ts --check
./bootstrap/configure-bifrost-clients.ts
./bootstrap/configure-bifrost-clients.ts --check
```

- `configure-llm-gateway.ts` and `./dotfiles maintain` preserve saved Codex,
  Claude, Cursor, and Grok logins. Bifrost enrollment removes OpenCode's built-in
  `opencode` and `opencode-go` credentials, including during maintenance.
- Personal `./dotfiles apply` retires them, respecting `preservedLogins`.
- To retire after checking explicit enrollment:

```zsh
./bootstrap/configure-llm-gateway.ts --retire-auth
./bootstrap/configure-llm-gateway.ts --check
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
- **`agent`:** both Cursor and Grok install this name. Call `cursor-agent` or
  `grok` to select the intended client.

### Rollback

```zsh
./bootstrap/configure-llm-gateway.ts --rollback
```

- Restores saved client configuration and Cursor symlinks; removes helpers.
- Deleted logins cannot be restored. Authenticate retired clients again before
  direct use.

## System Services

On macOS, install Colima's boot service from an authorized administrator
account for the user who owns Colima:

```zsh
sudo ./bootstrap/darwin/install-devbox-service-daemons.ts --user example --colima
sudo ./bootstrap/darwin/install-devbox-service-daemons.ts --user example --colima --check
```

- Retire competing user LaunchAgents before installation.
- Reference owner-only wrappers or files; never embed secrets.

Set `T3_SERVICE=1` in [local configuration](#local-configuration), then run
`./dotfiles apply` with the devbox profile to install the T3 Code service.
Unattended maintenance does not enroll new services. T3 owns later updates;
the [installation step](../bootstrap/install-t3-service.ts) preserves existing
units. Inspect it with:

```zsh
t3 service status
```

`./dotfiles check` proves the unit exists for opted-in users. On Linux it
also checks lingering and the running service's `PATH`. The systemd user
manager does not read shell startup files; for missing tools, follow
[bootstrap troubleshooting](bootstrap.md#troubleshooting). Enable lingering
as an administrator: `sudo loginctl enable-linger <user>`.

On macOS, keep the user logged in and the Mac awake; the LaunchAgent stops at
logout. Installing over SSH for a user with no GUI session writes the
LaunchAgent but cannot start it; the step reports the deferred start and the
service comes up at that user's next login, so a green apply does not by
itself prove the service is running.

Keep `--base-dir` stable across updates; see the upstream
[background service guide](https://github.com/pingdotgg/t3code/blob/main/docs/user/background-service.md).

## Software Updates and Cleanup

On macOS, enroll [headless updates](software-updates.md#headless-devbox-updates)
as the Homebrew owner to update packages and tools without a GUI login. On Linux, each user
enables the [systemd maintenance timer](software-updates.md#enable-and-use).

Use [Host hygiene](software-updates.md#host-hygiene) to preview cleanup,
protect active work, or apply removals with the updater idle.

## Verification

Run as the intended Unix user:

```zsh
./dotfiles check devbox # use personal-devbox for that profile
./verify/darwin/devbox-services.ts # macOS only
mise run audit devbox --format json
```

Audit prose can contain secrets. Collect JSON and report detector, path, and
line without copying matched values.
