# Migration Checklist

Use this when moving an existing Mac onto this repo.

## Install Fresh

Install the app and CLI layer:

```zsh
brew bundle --file ./Brewfile
```

Use mise for runtimes:

```zsh
mise install
```

Do not carry a home-level `~/.tool-versions`. Repos that need their own runtime
versions should declare them repo-locally.

## Carry Manually

- Berkeley Mono font files, if this machine should match the Ghostty and Zed
  font setup.
- App sign-ins and licenses.
- SSH private keys only when a new 1Password or GitHub key is not enough.
- Tizen cert/profile state, only when the machine needs Samsung TV signing.

## Tizen State

Do not commit Samsung/Tizen certificates, profiles, or device keys.

On the old Mac:

```zsh
cd ~/projects/uinaf/dotfiles
./scripts/tizen-pack.sh
```

Store the generated archive in a private password manager item.

On the new Mac:

```zsh
cd ~/projects/uinaf/dotfiles
./scripts/tizen-install.sh

TIZEN_1PASSWORD_REFERENCE='op://Vault/Item/archive' \
TIZEN_CERTS_SHA256='expected-sha256' \
  ./scripts/tizen-restore-from-1password.sh
```

`./scripts/tizen-pack.sh --full` can archive an old Studio install too. Prefer
a fresh Tizen Studio install unless the machine needs a fallback.

## Do Not Carry

- Codex config, auth, sessions, caches, worktrees, Browser approvals, or app
  state.
- Browser profiles.
- App caches.
- Docker or Colima state.
- `node_modules`, language-server caches, build folders, or Docker volumes.
- Tizen archives after restore.
