# Agent Setup

personal-workstation, personal-devbox, workstation, and devbox profiles install
machine-global instructions and skills. Assistant and service profiles install
neither.

## Global Rules

Chezmoi owns the shared rules and both agent entrypoints:

| Source | Target |
| --- | --- |
| `chezmoi/private_dot_agents/AGENTS.md.tmpl` | `~/.agents/AGENTS.md` |
| `chezmoi/private_dot_claude/symlink_CLAUDE.md` | `~/.claude/CLAUDE.md` |
| `chezmoi/private_dot_codex/symlink_AGENTS.md` | `~/.codex/AGENTS.md` |

Preview and apply rule changes with the normal dotfile commands:

```zsh
./dotfiles diff workstation
./dotfiles apply workstation
```

The links point to `../.agents/AGENTS.md`. They do not depend on a repository
checkout. Existing conflicting files or broken links are backed up by the
dotfile wrapper before chezmoi converges them.

### Private Rules

Optional machine-specific text comes from the machine-local chezmoi config. It
does not use a path in this repository. Add a string under the local `[data]`
table:

```toml
[data]
agentRulesPrivate = """
### Machine-specific rule

Add private instructions here.
"""
```

The value is appended under `## Local Overrides`. An absent or blank value adds
nothing. Preview before applying. Keep the local config and its contents out of
Git.

## Skill Sync

Run the profile-owned skill sync from any checkout:

```zsh
mise run agents:sync
mise run agents:update
```

The direct entrypoint is `./scripts/agents/sync.ts`. It reads the secure stored
profile marker, selects `shared.json` plus the personal layer when configured,
and installs those skills for available Codex and Claude Code CLIs. It does not
pull Git or manage rule files.

The ignored `scripts/agents/skills.lock.json` records the last manifest applied
by this checkout. Sync removes skills dropped from that lock while preserving
global skills it never owned. Removing an owned skill also removes its links
from every agent configured by the skills CLI.

When the lock is missing, sync installs the current manifest and initializes
ownership without removing anything. With no supported agent and no lock, it
skips installation and ownership initialization.

Pass `--update` to run `skills update -g` after manifest sync. That refreshes all
global skills, including extras the lock never owned. Manifest failures skip the
updater. An updater failure leaves the completed manifest sync in place.

Shared first-party skills live in [`uinaf/skills`](https://github.com/uinaf/skills).
Personal CLI-backed skills retain their owning repositories. Shared selections
live in `scripts/agents/skills/shared.json`; personal additions live in
`scripts/agents/skills/personal.json`.

## Verify

```zsh
mise run verify:domain config
mise run verify:domain agents
```

Rule fixtures cover clean and repeated applies, local data present and absent,
explicit diffs, conflicting files, and broken links. Skill fixtures cover
install, update, conflict, removal, and ownership without touching rules or Git.
