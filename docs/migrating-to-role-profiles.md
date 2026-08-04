# Migrating to Role Profiles

The role-profile release is intentionally breaking. It does not read, move,
rewrite, or delete state from the former owner-specific namespace. Inventory
and migrate each Unix user before applying the new profile.

## Before Applying

1. Back up the user's dotfiles, Git configuration, SSH configuration, and
   LaunchAgent/LaunchDaemon definitions.
2. Choose exactly one canonical role: `personal`, `workstation`, `devbox`,
   `assistant`, or `service`.
3. Inventory old state under `~/.config/uinaf`,
   `~/.local/libexec/uinaf`, `~/Library/LaunchAgents`, and
   `/Library/LaunchDaemons`.
4. Stop any old per-user or system service before installing its replacement.

Do not run the new installer until the files required by the selected role are
available at their canonical paths.

## Move User Configuration

Review each file before copying it. The relevant path changes are:

| Previous path | Canonical path |
|---|---|
| `~/.config/uinaf/profile` | `~/.config/dotfiles/profile` |
| `~/.config/uinaf/audit.env` | `~/.config/dotfiles/audit.env` |
| `~/.config/uinaf/devbox.env` | `~/.config/dotfiles/devbox.env` |
| `~/.config/uinaf/sudo-age-identity.txt` | `~/.config/dotfiles/sudo-age-identity.txt` |
| `~/.local/libexec/uinaf/git-ssh-sign-agentless` | `~/.local/libexec/dotfiles/git-ssh-sign-agentless` |

Set the canonical profile marker to one line containing the selected role and
make local configuration owner-only:

```sh
chmod 0700 "$HOME/.config/dotfiles"
chmod 0600 "$HOME/.config/dotfiles"/*
```

The compatibility name `personal` is accepted as input, but new persisted
state should use `workstation`.

The migrated sudo age identity remains sudo-specific. Do not copy or reuse it
as the general SOPS identity. After installing the selected profile's Homebrew
layers, create and back up the separate SOPS identity described in
[Identity provisioning](identities.md):

```sh
./scripts/secrets/configure-sops-age-identity.sh
```

## Apply and Reconfigure Git

Preview first, then apply:

```sh
role=workstation
./scripts/bootstrap/apply-dotfiles.sh --profile "$role" --dry-run --verbose
./scripts/bootstrap/apply-dotfiles.sh --profile "$role"
mise trust
mise install
./scripts/bootstrap/install.sh --profile "$role"
```

For `workstation` and `devbox`, remove the former marker-delimited GitHub block
from `~/.ssh/config.local`, preserve any unrelated directives, and rerun:

```sh
./scripts/bootstrap/configure-git.sh --profile "$role"
```

For `assistant`, configure workload authorship first, then use the generic
GitHub App configurator with explicit operator-supplied App and repository
values:

```sh
GIT_USER_NAME='Workload Name' \
GIT_USER_EMAIL='APP_BOT_NOREPLY_EMAIL' \
  ./scripts/bootstrap/configure-git.sh --profile assistant --non-interactive

./scripts/bootstrap/configure-assistant-github-app.sh \
  --name example-app \
  --app-id APP_ID \
  --installation-id INSTALLATION_ID \
  --repo github.com/example/workspace
```

For `service`, configure unsigned workload authorship without installing an
assistant GitHub App or human credential helper:

```sh
GIT_USER_NAME='Service Name' \
GIT_USER_EMAIL='service@example.invalid' \
  ./scripts/bootstrap/configure-git.sh --profile service --non-interactive
```

## Devbox Services

The default service namespace is now
`local.dotfiles.<service>.<unix-user>`. Before installing a replacement, an
authorized host administrator must unload and archive any matching old
`com.uinaf.*` system job and the former per-user `com.uinaf.process-compose`,
`ai.openclaw.gateway`, or `com.uinaf.healthd` LaunchAgent. The installer stops
when one of those jobs is still loaded or its plist is still active; it does
not retire it automatically.

After the old job is retired, install one replacement service at a time using
the commands in [Devbox Setup](devbox.md).

## Verify Before Removing Backups

Run the role contract and the relevant host audit:

```sh
role=workstation
./scripts/verify/bootstrap.sh --profile "$role"
./scripts/audit/host.sh
```

For an assistant, also run:

```sh
./scripts/verify/assistant-git-boundary.sh
```

For a service, run:

```sh
./scripts/verify/workload-git-boundary.sh --profile service
```

Verify the workload and its channels end to end before deleting archived
configuration or service definitions. Cleanup is deliberately an
agent/operator task, not part of the dotfiles installer.
