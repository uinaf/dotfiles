# Agent Setup

The workstation and devbox profiles install machine-global instructions and
skills from `scripts/agents/`. The assistant profile does not install coding
agents, global instructions, or development skills.

## Sync

Run the profile-owned sync from the primary dotfiles checkout on `main`:

```zsh
mise run agents:sync
```

The equivalent direct entrypoint is `./scripts/agents/sync.ts`.

The sync fast-forwards the clean dotfiles checkout, generates
`scripts/agents/rules/final.md`, links it to installed Codex and Claude Code
entrypoints, and installs every entry in `scripts/agents/skills.json`. The
ignored `scripts/agents/skills.lock.json` records the last manifest successfully
applied by this checkout. Later syncs remove skills dropped from that lock while
preserving globally installed skills the lock never owned.

When the lock is missing, sync installs the current manifest and initializes the
lock without removing anything. Before migrating a machine that predates
ownership tracking, seed the lock only with entries confirmed to have been
installed by the former manifest sync.
First-party skill source lives in [`uinaf/skills`](https://github.com/uinaf/skills).

Regular files and foreign symlinks at the global instruction entrypoints are
rejected before global state changes.

## Sources

| Path | Ownership |
| --- | --- |
| `scripts/agents/rules/base.md` | Tracked global rules. |
| `scripts/agents/rules/local.md` | Ignored optional machine overrides. |
| `scripts/agents/rules/final.md` | Ignored generated rules linked into installed agents. |
| `scripts/agents/skills.json` | Tracked desired managed skill selection. |
| `scripts/agents/skills.lock.json` | Ignored machine-local ownership ledger for safe removal. |
| `scripts/agents/sync.ts` | Executable sync entrypoint. |

## Local Rules

Put private machine-specific additions in `scripts/agents/rules/local.md`.
Start local content at heading level three; the generated file inserts it below
`## Local Overrides`.

Do not edit `scripts/agents/rules/final.md` or installed copies under
`~/.agents/skills/`. Edit the tracked rule source here or the skill in its
owning repository, then rerun the sync.

## Verify

Repository verification exercises the typed sync in an isolated fixture. A
live workstation or devbox bootstrap runs the same sync after Codex, Claude
Code, Node, and pnpm are installed.
