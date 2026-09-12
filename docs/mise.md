# Mise Tasks

[Root mise.toml](../mise.toml) owns repository tasks.
[The profile template](../chezmoi/.chezmoitemplates/mise.toml) owns installed
runtime pins and runtime packages. Keep task entries as command delegations;
parsing and policy belong in `scripts/`.

## Tasks

Trust each checkout before using mise; without trust, task discovery and
runtime installation fail.

```zsh
mise trust
mise tasks
mise tasks validate
mise run verify:domain config # focused domain
mise run verify:fast          # all deterministic checks
mise run verify               # deterministic checks plus full-history secret scan
```

- The [verification registry](../scripts/verify/checks.json) lists commands,
  domains, and proof. Focused runs omit checks marked `scope: "complete"`.
- Each check has a five-minute timeout.
- [Contributing](../CONTRIBUTING.md#deliver) covers CI and delivery requirements.

## Task Namespaces

| Task | Guide |
| --- | --- |
| `dotfiles:diff`, `dotfiles:apply` | [Edit dotfiles](chezmoi.md#workflow) |
| `agents:sync`, `agents:update`, `agents:doctor` | [Agent selections](agents.md#skill-sync) |
| `maintenance:*` | [Software updates](software-updates.md) |
| `xcode:install`, `xcode:check` | [Xcode pin](mobile-and-tv-development.md#xcode-and-tvos-simulator) |
| `audit` | [Security audits](security-audits.md) |

Live checks inspect the current Unix user's machine. Run only for its intended
profile; these are separate from repository verification:

```zsh
mise run verify:bootstrap workstation # or developer, devbox, personal-devbox, personal-workstation
mise run verify:devbox-services
```

For generated agent worktrees whose mise configs need trust:

```zsh
mise run bootstrap:trust-agent-worktrees
```

Bootstrap runs this helper for existing configs near `~/.codex/worktrees` and
`~/.claude/worktrees`; new worktrees may need another run.

## Runtime Pins

Edit [the profile template](../chezmoi/.chezmoitemplates/mise.toml), preview with
`mise run dotfiles:diff <profile>`, and run `mise run verify`.
Use exact versions where practical. Keep these pairs aligned:

- Profile Node, repository [.node-version](../.node-version), and
  [package.json](../package.json).
- Profile and repository pnpm.
- Corepack installed by `dotfiles:runtime-packages` before `corepack enable`.
- PyYAML installation and its [live verifier](../scripts/verify/bootstrap.ts).
- [Xcode release](../chezmoi/.chezmoidata/xcode.json) and `mise run xcode:install`.

- Bootstrap runs `mise install` and `dotfiles:runtime-packages`, so package-only
  pin changes converge even when runtimes are already installed.
- The package task installs npm, Corepack, Corepack's global pnpm default, and PyYAML;
  ordinary project installs do not run it.
- A project's `packageManager` selects its own package-manager version.
- Renovate follows mise toolchain patch and minor releases (Node, Bun, uv,
  and the other `[tools]` pins) after one day, at any time. npm, pnpm, and
  Corepack stay on the shared seven-day age gate.
