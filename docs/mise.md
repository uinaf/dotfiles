# Mise Tasks

Mise is the contributor interface for repository tasks. Operators use
`./dotfiles diff|apply|check <profile>` for per-user convergence.

This repo uses mise in two scopes:

- Root `mise.toml` defines the repository task graph.
- `chezmoi/private_dot_config/mise/config.toml.tmpl` defines profile runtime
  pins, shared CLIs, and trusted generated worktree roots applied to the home
  config.

Keep task entries as single-command delegations. Parsing, validation, and
business logic belong in lintable files under `scripts/`.

Trust the repo config once per checkout before using repo tasks or installing
runtime pins:

```zsh
mise trust
```

Without that local trust record, mise refuses to parse `mise.toml`, so
`mise install`, `mise tasks`, and `mise run ...` all fail before task discovery.

## Tasks

Inspect and validate the graph with:

```zsh
mise trust
mise tasks --json
mise tasks validate
mise tasks deps verify
```

Use the smallest verification task that owns the change:

```zsh
mise run verify:domain config # focused domain
mise run verify:fast          # complete deterministic graph
mise run verify               # deterministic graph plus history scan
```

- Each check declares its command and proof in the
  [verification registry](../scripts/verify/checks.json). Checks marked
  `complete only` cover cross-domain parity and stay out of focused runs.
- Each check reports as soon as it finishes and has a five-minute timeout;
  timeout cancels its scoped child process, preserves collected output, and
  fails the gate.
- The complete task depends on `verify:fast` and the hidden history scan; mise
  runs those independent dependencies in parallel.
- Pull request and manual CI checks run the complete deterministic graph.
  Direct pushes require `mise run verify` locally; release jobs do not run checks.

## Task Namespaces

Repository checks, beyond the verification tasks above:

```zsh
mise run audit repo
mise run audit repo --format json
mise run audit mscp
```

Live host checks run only as the Unix user that should satisfy the selected
profile or audit boundary:

| Surface | Command | Proves |
| --- | --- | --- |
| Workstation | `mise run verify:bootstrap workstation` | Required package layers, SOPS/age CLIs, mise tools, Codex CLI, and managed config exist. Age identity is optional until secrets are consumed. |
| Personal workstation | `mise run verify:bootstrap personal-workstation` | Workstation package and runtime contracts exist with personal packages, dotfiles, and skills selected. |
| Personal devbox | `mise run verify:bootstrap personal-devbox` | Devbox package, identity, and runtime contracts exist with headless personal tools, dotfiles, and skills selected. |
| Devbox | `mise run verify:bootstrap devbox` | Developer package layers, age identity, mise tools, Codex CLI, and managed config exist. |
| Devbox services | `mise run verify:devbox-services` | Launchd, age, and local service configuration match the shared-host contract. |
| Workstation drift | `mise run audit workstation` | Human Git, SSH, Codex, secret, permission, and local-state boundaries are visible. |
| Devbox drift | `mise run audit devbox` | Agent-user identity, service, secret, project-permission, and Tailscale boundaries are visible. |
| Host hardening | `mise run audit host` | Lynis reports the current host hardening index, warnings, and suggestions. |

Live audits support `--format json` for compact collection. Treat raw prose
output as sensitive because maintained scanners may include matched material.

Bootstrap helpers:

```zsh
mise run agents:sync
mise run agents:update
mise run bootstrap:trust-agent-worktrees
```

- `agents:sync` installs the profile-selected skills, plugin marketplaces, and
  MCP servers described in [Agent setup](agents.md).
- `agents:update` also refreshes globally installed skills and managed plugins.
- Both run `./scripts/agents/plugins.ts` and `./scripts/agents/mcps.ts` after the
  skill sync.
- Workstation and devbox configs trust Codex and Claude generated worktree roots:
  `~/.codex/worktrees` and `~/.claude/worktrees`.
- `bootstrap:trust-agent-worktrees` also refreshes trust for existing
  `mise.toml` and `.mise.toml` files near those roots, and is called by
  `scripts/bootstrap/install.ts`.

## Runtime Pins

When changing `chezmoi/private_dot_config/mise/config.toml.tmpl`:

1. Confirm which profiles should receive the pin.
2. Keep exact versions where practical.
3. Preview dotfile output with `mise run dotfiles:diff <profile>`.
4. Run `mise run verify`.

Avoid floating runtime versions such as `latest` in profile machine config.

The runtime group shared by `personal-workstation`, `personal-devbox`,
`workstation`, and `devbox`:

- pins Ruby alongside its other development runtimes
- installs PyYAML 6.0.3 into the mise-managed Python for bundled Codex skill
  validation
- enables Corepack in its Node entry and installs pnpm 12.0.0 as the default
  outside projects
- pins npm itself to 12.0.2 through the Node postinstall
- declares Playwright CLI as an exact `npm:` backend entry

A project's `packageManager` field remains the repository-owned version source.
Vite+ stays repository-local and is invoked through the owning package manager.

Install and verification:

- `scripts/bootstrap/install.ts` calls `mise install` once for every profile with
  a runtime group, then installs the repository's locked Effect dependencies
  through that runtime. Mise owns the Node postinstall that pins npm and the
  stable pnpm default.
- `scripts/verify/bootstrap.ts` checks that rendered mise tools converged and
  that their commands resolve from mise.
- Independent live-check groups run in parallel and print one success line each.
  Pass `--verbose` to expose successful command output.

Its `mise doctor` PATH-ordering probes run through a clean login or interactive
zsh that does not inherit an already-activated caller mise session or PATH, so a
healthy workstation is not rejected only because the verifier itself started
inside mise.

| Probe | PATH source |
| --- | --- |
| Login (`-lic`) | Rebuilt through normal login startup |
| Interactive-only (`-ic`) | Minimal Homebrew and system seed, then interactive startup files, so a parent login shell's ambient PATH is intentionally not reproduced |
