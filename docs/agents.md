# Agent Setup

The selected [profile](profiles.md) controls global rules, skills, plugins,
and MCP servers.

## Global Rules

[Rule sources](../agents/rules.json) supply the shared text.
[Chezmoi](../chezmoi/private_AGENTS.md.tmpl) combines it with private fragments
into `~/AGENTS.md`; `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` link there.
Edit shared rules at their configured source and private instructions in:

| File                                 | Position            |
| ------------------------------------ | ------------------- |
| `~/.config/dotfiles/agents.start.md` | Before shared rules |
| `~/.config/dotfiles/agents.end.md`   | After shared rules  |

- Fragments are optional, literal Markdown. Each file or resolved symlink target
  must be a regular file owned by the current user with no group or other access.
- Generated rule files are replaced without backups. Keep private edits in fragments.

Preview and apply through the [profile setup workflow](bootstrap.md#apply-a-profile).

The [rule loader](../agents/rules.ts) owns validation and cache fallback.
Invalid content leaves the existing cache intact. If fetching or scanning is
unavailable, setup needs a valid cache to continue. Set
`DOTFILES_AGENT_RULES_OFFLINE=1` to require cached rules without fetching.

## Skill Sync

Keep stack-specific skills in the consuming repository. Use `slopskills` from
the [configured workflow plugin](../agents/plugins/developer.json) to select
and install them from repository evidence and the current task.
Global manifests retain shared workflows; its catalog owns the React,
TanStack, web UI, Swift, and Effect recommendations.

Run from the checkout after bootstrap has stored the profile:

```zsh
mise run agents:sync
mise run agents:update
```

- `update` also refreshes **all global skills**, including manually installed
  extras, and managed plugins.
- A failed global skill update leaves the completed manifest sync in place.
- These commands do not pull Git or refresh rule files.

Edit the selected layer under each manifest directory:

| Selection   | Manifests                      | Implementation                     |
| ----------- | ------------------------------ | ---------------------------------- |
| Skills      | [skills/](../agents/skills/)   | [sync.ts](../agents/sync.ts)       |
| Plugins     | [plugins/](../agents/plugins/) | [plugins.ts](../agents/plugins.ts) |
| MCP servers | [mcps/](../agents/mcps/)       | [mcps.ts](../agents/mcps.ts)       |

The [profile model](../chezmoi/.chezmoidata/profiles.json) selects `skillLayers`;
each parser defines its manifest fields and supported harnesses.

Each sync keeps an ignored `agents/{skills,plugins,mcps}.lock.json`:

- Missing locks initialize ownership without removing existing installations.
- Subsequent runs remove dropped selections while preserving never-owned extras.
- Plugin and MCP removals awaiting a missing CLI remain owned until it returns.
- Failed installs or removals leave that sync's lock unchanged; earlier successful
  commands may already have changed the host. Fix the reported failure and rerun.

## Plugin Sync

- Cursor marketplace installs need completion in `/plugins`. If imports are
  blocked, `cursorMode: "skills"` uses skill links and requires both `cursor`
  and `claude` in `harnesses`.
- OpenCode always uses skill links. Both link from
  `~/.claude/plugins/marketplaces/<marketplaceId>/skills/`, so the Claude
  marketplace checkout must exist. Links follow its updates.
- Existing files or never-owned links at a selected skill name are reported
  rather than replaced. First sync does not prune links.
- Cursor marketplace removal stays interactive and remains owned until a later
  sync confirms removal.

## MCP Sync

Executor and other OAuth servers expire their sessions per harness. Check
every installed harness at once and get the repair command per row:

```zsh
mise run agents:doctor
```

Use the repair command printed by [doctor.ts](../agents/doctor.ts). Cursor
stores OAuth tokens per project; use [cursor-mcp-seed.ts](../agents/cursor-mcp-seed.ts)
to seed a new checkout or worktree.

Over SSH the callback port stays on the remote host: run the login under
`ssh -t` (Claude and Codex need a TTY) and forward the printed loopback port
with `ssh -L PORT:127.0.0.1:PORT` before opening the URL locally.

The doctor also reports Grok installation drift and prints the repair command.
Review it before removing a conflicting installation.

## Verify

```zsh
mise run verify:domain agents
mise run verify:domain config
```
