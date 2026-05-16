# Chezmoi Source State

This repo uses chezmoi for public-safe dotfile source state. Chezmoi owns files
under `chezmoi/` and applies them to `$HOME` through
`scripts/bootstrap/apply-dotfiles.sh`.

## Source Layout

Use chezmoi source attributes instead of literal target filenames:

| Source | Target |
| --- | --- |
| `chezmoi/dot_zshrc` | `~/.zshrc` |
| `chezmoi/dot_gitconfig` | `~/.gitconfig` |
| `chezmoi/private_dot_config/mise/config.toml` | `~/.config/mise/config.toml` |
| `chezmoi/private_dot_ssh/private_config` | `~/.ssh/config` |
| `chezmoi/private_dot_config/zed/private_settings.json` | `~/.config/zed/settings.json` |

The `private_` attribute is used for parent config directories and files that
should land as owner-only local config.

Use attributes deliberately:

- `dot_` maps to a leading dot.
- `private_` sets restrictive permissions for target files and directories.
- `executable_` is only for target files that must be executable.
- `.tmpl` is only for real host, user, or OS branching. Keep templates small
  and avoid secrets unless values are fetched at apply time from an approved
  external secret source.

## Workflow

Preview the target state before applying:

```zsh
./scripts/bootstrap/apply-dotfiles.sh --dry-run --verbose
mise run dotfiles:diff
```

Apply the source state:

```zsh
./scripts/bootstrap/apply-dotfiles.sh
mise run dotfiles:apply
```

`./scripts/bootstrap/install.sh` calls the same wrapper and then configures
Codex defaults when `codex` is available.

For normal edits:

1. Edit the source file under `chezmoi/`.
2. Preview with `mise run dotfiles:diff`.
3. If changing bootstrap behavior, test in a temporary destination:

```zsh
tmp_dest="$(mktemp -d /tmp/uinaf-chezmoi-apply.XXXXXX)"
chezmoi --source "$PWD/chezmoi" --destination "$tmp_dest" --force apply
find "$tmp_dest" -maxdepth 4 -type f -o -type l | sort
rm -rf "$tmp_dest"
```

For permission-sensitive paths, verify modes with:

```zsh
stat -f '%OLp %N' "$path"
```

## Boundaries

- Edit files under `chezmoi/`, not generated files in `$HOME`.
- Keep `chezmoi.toml`, local data files, hostnames, identities, vault names,
  item names, tokens, private keys, and generated env files out of Git.
- Prefer public-safe templates and local-only config over checked-in secret
  references.
- Do not use `exact_` at `$HOME` scope.
- Do not add `run_`, `run_once_`, or `run_onchange_` scripts unless the repo
  explicitly needs that lifecycle and the docs explain it.
- Do not use `chezmoi add` against the live home directory when migrating
  already tracked repo files. Prefer repo-local edits or `git mv` so history
  and review stay clear.
- Keep macOS GUI state, App Store auth, 1Password sessions, Tailscale node
  identity, Tizen secrets, and root-owned devbox env refresh state in the
  existing explicit scripts or manual setup docs.

## Package And Runtime Layers

Chezmoi applies dotfiles only. Homebrew Bundle remains the package layer, and
mise remains the runtime/tool-version layer. Do not duplicate package lists into
chezmoi scripts unless there is a concrete idempotency reason.

## Wrapper Expectations

Keep `scripts/bootstrap/apply-dotfiles.sh` non-interactive and preserve:

- `--dry-run` and `--verbose`.
- Backups for pre-existing local files before `--force apply`.
- Cleanup of obsolete old `home/` symlinks.
- A final `mise run verify` before handoff when wrapper behavior changes.
