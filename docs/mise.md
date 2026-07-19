# Mise Tasks

This repo uses mise in two different scopes:

- `.mise/tasks/` defines repo tasks for humans and agents.
- Root `mise.toml` is the repo-level mise config and documents that task
  entrypoints live in `.mise/tasks/`.
- `chezmoi/private_dot_config/mise/config.toml` defines machine runtime pins,
  Corepack/pnpm setup, shared npm CLIs, and trusted generated worktree roots
  applied into `~/.config/mise/config.toml`.

Do not mix those scopes. A repo command belongs in `.mise/tasks/`; a shared
machine runtime pin belongs in the chezmoi-managed home config.

Trust the repo config once per checkout before using repo tasks or installing
runtime pins:

```zsh
mise trust
```

Without that local trust record, mise refuses to parse `mise.toml`, so
`mise install`, `mise tasks`, and `mise run ...` all fail before task discovery.

## Tasks

Keep task wrappers deterministic and non-interactive:

- Use explicit repo-relative commands such as `./scripts/verify/repo.sh`.
- Add a concise `#MISE description="..."` header for every task.
- Prefer task names users can guess: `verify`, `verify:fast`,
  `dotfiles:diff`, `dotfiles:apply`.
- Do not embed secrets, hostnames, personal paths, or environment-specific
  credentials.
- Do not replace repo scripts with long wrapper logic when a script already
  owns the behavior.
- Keep task files executable so mise can discover them.

Nested file tasks define the visible task namespace:

```text
.mise/tasks/verify/_default        -> mise run verify
.mise/tasks/verify/fast            -> mise run verify:fast
.mise/tasks/audit/repo/_default    -> mise run audit:repo
.mise/tasks/audit/repo/json        -> mise run audit:repo:json
```

Inspect tasks with:

```zsh
mise trust
mise tasks --json
```

Run the changed task directly, then run:

```zsh
mise run verify
```

## Task Namespaces

Repository checks:

```zsh
mise run verify
mise run verify:repo
mise run verify:fast
mise run audit:repo
mise run audit:repo:json
mise run audit:mscp
```

Live host checks:

```zsh
mise run verify:bootstrap:personal
mise run verify:bootstrap:devbox
mise run verify:devbox-services
mise run audit:host
mise run audit:host:json
mise run audit:personal
mise run audit:personal:json
mise run audit:devbox
mise run audit:devbox:json
```

Use repo checks for ordinary PR work. Use live host checks only on a machine
that should actually satisfy that profile or audit boundary.

Bootstrap helpers:

```zsh
mise run bootstrap:trust-agent-worktrees
```

The shared machine config trusts Codex and Claude generated worktree roots:
`~/.codex/worktrees` and `~/.claude/worktrees`. The helper also refreshes trust
for existing `mise.toml` and `.mise.toml` files near those roots, and is called
by `scripts/bootstrap/install.sh`.

## Runtime Pins

When changing `chezmoi/private_dot_config/mise/config.toml`:

1. Confirm the pin is intended for all uinaf machines.
2. Keep exact versions where practical.
3. Preview dotfile output with `mise run dotfiles:diff`.
4. Run `mise run verify`.

Avoid floating runtime versions such as `latest` in shared machine config.

The Node entry enables Corepack and pins the default pnpm release used outside
projects. Projects still select their own package-manager release through the
`packageManager` field. Shared npm CLIs such as npm itself, Playwright CLI, and
Vite+ are exact `npm:` backend entries, so `mise install` owns their versions
without relying on ambient global npm state.

`scripts/bootstrap/install.sh` reapplies the Corepack pnpm shim and default
release when refreshing an existing Node installation. A fresh Node install
gets the same state from mise's Corepack setting and Node postinstall hook.
`scripts/verify/bootstrap.sh` checks the commands and exact shared versions on
both profiles.
