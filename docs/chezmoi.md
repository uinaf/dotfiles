# Chezmoi Source State

This repo uses chezmoi for public-safe dotfile source state. Chezmoi owns files
under `chezmoi/` and applies them to `$HOME` through
`scripts/bootstrap/apply-dotfiles.sh`.

## Source Layout

Use chezmoi source attributes instead of literal target filenames:

| Source | Target |
| --- | --- |
| `chezmoi/.chezmoidata/profiles.json` | Versioned template data for profile capabilities and composition |
| `chezmoi/dot_zshrc` | `~/.zshrc` |
| `chezmoi/dot_gitconfig.tmpl` | `~/.gitconfig` |
| `chezmoi/private_dot_config/mise/config.toml.tmpl` | `~/.config/mise/config.toml` |
| `chezmoi/private_dot_config/private_dotfiles/profile.tmpl` | `~/.config/dotfiles/profile` |
| `chezmoi/private_dot_ssh/private_config` | `~/.ssh/config` |
| `chezmoi/private_dot_local/private_libexec/private_dotfiles/private_executable_git-ssh-sign-agentless` | `~/.local/libexec/dotfiles/git-ssh-sign-agentless` |
| `chezmoi/private_dot_claude/modify_private_settings.json` | Selected values inside `~/.claude/settings.json` for developer profiles |
| `chezmoi/private_AGENTS.md.tmpl` | `~/AGENTS.md`, the shared global agent rules composed with optional start and end Markdown fragments |
| `chezmoi/private_dot_claude/symlink_CLAUDE.md` | `~/.claude/CLAUDE.md` link to `~/AGENTS.md` |
| `chezmoi/private_dot_codex/symlink_AGENTS.md` | `~/.codex/AGENTS.md` link to `~/AGENTS.md` |

The `private_` attribute is used for parent config directories and files that
should land as owner-only local config.

Personal-workstation and workstation manage Ghostty settings. All four
developer profiles share GitHub authentication, outbound SSH, signing-helper,
and allowed-signers sources. Assistant and service profiles render a minimal
Git base with a local workload-identity include and exclude those developer
surfaces; only assistant includes the optional GitHub App helper.

All four developer profiles set `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` in the `env`
object of the Claude Code user settings. The modify template preserves unrelated
settings and sibling environment values. User settings are the lowest-precedence
Claude Code scope; project, local, command-line, and managed settings can override
this default. The repository does not manage `~/.claude.json`.

The developer SSH entrypoint is exclusively Chezmoi-managed. Host-specific
directives belong in `~/.ssh/config.local`, and tools that support a configurable
output path should own a fragment under `~/.ssh/config.d/*.conf`. Tools with a
fixed generated path receive a stable managed include; for example, Colima owns
and regenerates `~/.colima/ssh_config` as its virtual machines start and stop.
Do not preserve arbitrary mutations to `~/.ssh/config`: route each writer to its
own included file so unexpected changes remain visible as drift.

Use attributes deliberately:

- `dot_` maps to a leading dot.
- `private_` sets restrictive permissions for target files and directories.
- `executable_` is only for target files that must be executable.
- `.tmpl` is only for real host, user, or OS branching. Keep templates small
  and avoid secrets unless values are fetched at apply time from an approved
  external secret source.

## Workflow

Operators preview and apply the full per-user flow through the root command:

```zsh
mise trust
./dotfiles diff workstation
./dotfiles apply workstation
```

Contributors changing chezmoi source use the repository task interface:

```zsh
mise trust
mise run dotfiles:diff workstation
mise run dotfiles:apply workstation
```

`./dotfiles apply` delegates to `scripts/bootstrap/install.sh`, which applies
the same source before running the remaining profile install steps.

For normal edits:

1. Edit the source file under `chezmoi/`.
2. Preview with `mise run dotfiles:diff <profile>`.
3. If changing bootstrap behavior, test in a temporary destination:

```zsh
tmp_dest="$(mktemp -d /tmp/dotfiles-chezmoi-apply.XXXXXX)"
chezmoi --source "$PWD/chezmoi" --destination "$tmp_dest" \
  --override-data '{"dotfilesProfile":"workstation"}' --force apply
find "$tmp_dest" -maxdepth 4 -type f -o -type l | sort
rm -rf "$tmp_dest"
```

For permission-sensitive paths, verify modes with:

```zsh
stat -f '%OLp %N' "$path"
```

## Boundaries

- Edit files under `chezmoi/`, not generated files in `$HOME`.
- Keep `chezmoi.toml`, `~/.config/dotfiles/agents.start.md`,
  `~/.config/dotfiles/agents.end.md`, local data
  files, hostnames, identities, vault names, item names, tokens, private keys,
  and generated env files out of Git.
- Prefer public-safe templates and local-only config over checked-in secret
  references.
- Do not use `exact_` at `$HOME` scope.
- Do not add `run_`, `run_once_`, or `run_onchange_` scripts unless the repo
  explicitly needs that lifecycle and the docs explain it.
- Do not use `chezmoi add` against the live home directory when migrating
  already tracked repo files. Prefer repo-local edits or `git mv` so history
  and review stay clear.
- Keep macOS GUI state, App Store auth, 1Password sessions, Tailscale node
  identity, Tizen secrets, and local secret-manager auth state in the existing
  explicit scripts or manual setup docs.

## Package and Runtime Layers

Chezmoi applies dotfiles only. Homebrew Bundle remains the package layer, and
mise remains the runtime/tool-version layer. Do not duplicate package lists into
chezmoi scripts unless there is a concrete idempotency reason.

## Wrapper Expectations

Keep `scripts/bootstrap/apply-dotfiles.sh` non-interactive and preserve:

- `--dry-run` and `--verbose`.
- Backups for pre-existing local files before `--force apply`.
- `mise run verify:domain config` and `mise run verify:domain profiles` when
  wrapper behavior changes.
