# Mise Tasks

This repo uses mise in two different scopes:

- `.mise/tasks/` defines repo tasks for humans and agents.
- Root `mise.toml` is the repo-level mise config and documents that task
  entrypoints live in `.mise/tasks/`.
- `chezmoi/private_dot_config/mise/config.toml.tmpl` defines profile runtime pins,
  Corepack-managed pnpm setup, shared npm CLIs, and trusted generated worktree roots
  applied into `~/.config/mise/config.toml`.

Do not mix those scopes. A repo command belongs in `.mise/tasks/`; a profile
runtime pin belongs in the chezmoi-managed home config.

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
mise run verify:bootstrap:personal-workstation
mise run verify:bootstrap:personal-devbox
mise run verify:bootstrap:workstation
mise run verify:bootstrap:devbox
mise run verify:bootstrap:assistant
mise run verify:bootstrap:service
mise run verify:devbox-services
mise run audit:host
mise run audit:host:json
mise run audit:workstation
mise run audit:workstation:json
mise run audit:devbox
mise run audit:devbox:json
```

Use repo checks for ordinary PR work. Use live host checks only on a machine
that should actually satisfy that profile or audit boundary.
Bootstrap helpers:

```zsh
mise run agents:sync
mise run agents:sync -- --update
mise run bootstrap:trust-agent-worktrees
```

`agents:sync` refreshes developer-profile global instructions and the
profile-selected skills described in [Agent setup](agents.md). Pass `--update` after
`--` to also refresh every globally installed skill with `skills update -g`.

Workstation and devbox configs trust Codex and Claude generated worktree roots:
`~/.codex/worktrees` and `~/.claude/worktrees`. The helper also refreshes trust
for existing `mise.toml` and `.mise.toml` files near those roots, and is called
by `scripts/bootstrap/install.sh`.

## Runtime Pins

When changing `chezmoi/private_dot_config/mise/config.toml.tmpl`:

1. Confirm which profiles should receive the pin.
2. Keep exact versions where practical.
3. Preview dotfile output with `mise run dotfiles:diff`.
4. Run `mise run verify`.

Avoid floating runtime versions such as `latest` in profile machine config.

The personal-workstation/personal-devbox/workstation/devbox Node entry enables Corepack and installs pnpm 11.20.0 as
the default outside projects. A project's `packageManager` field remains the
repository-owned version source. The Node postinstall pins npm itself to
12.0.2, while Playwright CLI is an exact `npm:` backend entry. Vite+ stays
repository-local and is invoked through the owning package manager.

`scripts/bootstrap/install.sh` enables Corepack, installs the stable pnpm
default, removes the retired Vite+ package from both the mise npm backend and
every installed mise Node version, preserves the user-level `~/.vite-plus`
cache used by repository-local installs, and force-rebuilds mise shims so
retired commands are pruned. A
fresh Node install gets the same pnpm state from the Node postinstall hook.
The assistant profile intentionally contains only Node. The service profile
declares no language runtime. Additional runtimes belong to the workload that
requires them.
`scripts/verify/bootstrap.sh` checks the commands and versions required by the
selected profile. Its `mise doctor` PATH-ordering probes run through a clean
login/interactive zsh that does not inherit an already-activated caller mise
session or PATH, so a healthy workstation is not rejected only because the
verifier itself started inside mise. Login probes (`-lic`) still rebuild PATH
through normal login startup; interactive-only probes (`-ic`) start from a
minimal Homebrew/system seed and then apply interactive startup files, so they
intentionally do not reproduce a parent login shell's ambient PATH.
