# Agent Setup

The workstation and devbox profiles install machine-global instructions and
skills from `scripts/agents/`. Assistant and service profiles do not install
coding agents, global instructions, or development skills.

## Sync

Run the profile-owned sync from the primary dotfiles checkout on `main`:

```zsh
mise run agents:sync
mise run agents:sync -- --update
```

The equivalent direct entrypoint is `./scripts/agents/sync.ts`.

The sync fast-forwards the clean dotfiles checkout, generates
`scripts/agents/rules/final.md`, links it to installed Codex and Claude Code
entrypoints, and installs every entry in `scripts/agents/skills.json`. The
ignored `scripts/agents/skills.lock.json` records the last manifest successfully
applied by this checkout. Later syncs remove skills dropped from that lock while
preserving globally installed skills the lock never owned. Removing an owned
skill also removes its links from every agent configured by the skills CLI.
Retired owned skills are still removed when neither supported coding agent is
installed; only current-skill installation is skipped.

Pass `--update` to run `skills update -g` after a successful manifest sync.
That refreshes every globally installed skill, including extras the lock never
owned. Manifest install failures skip the updater; an updater failure still
leaves the completed manifest sync in place.

When the lock is missing and a supported coding agent is installed, sync
installs the current manifest and initializes the lock without removing
anything. With no supported agent and no lock, sync skips installation and
ownership initialization. Before migrating a machine that predates ownership
tracking, seed the lock only with entries confirmed to have been installed by
the former manifest sync.
Shared first-party skills live in [`uinaf/skills`](https://github.com/uinaf/skills).
The autoreview skill ships with
[`uinaf/autoreview`](https://github.com/uinaf/autoreview) and invokes the CLI
installed by the developer Homebrew layer. The slopomatic skill ships with
[`uinaf/slopomatic`](https://github.com/uinaf/slopomatic) the same way.

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
