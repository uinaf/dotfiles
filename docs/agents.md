# Agent Setup

The five [profiles](profiles.md) install global rules, skills,
plugins, and MCP servers.

## Global Rules

[Rule sources](../scripts/agents/rules.json) supply the shared text.
[Chezmoi](../chezmoi/private_AGENTS.md.tmpl) combines it with private fragments
into `~/AGENTS.md`; `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` link there.
Edit shared rules at their configured source and private instructions in:

| File | Position |
| --- | --- |
| `~/.config/dotfiles/agents.start.md` | Before shared rules |
| `~/.config/dotfiles/agents.end.md` | After shared rules |

- Fragments are optional, literal Markdown. Each file or resolved symlink target
  must be a regular file owned by the current user with no group or other access.
- Shared rules begin at `## General guidelines`; fragments own their headings.
- Generated rule files are replaced without backups. Keep private edits in fragments.
- Managed Claude and Codex settings disable native auto-memory.

Preview and apply with the selected profile:

```zsh
./dotfiles diff workstation
./dotfiles apply workstation
```

- Both commands refresh `${XDG_STATE_HOME:-~/.local/state}/dotfiles/agent-rules.md`.
- Fetched sources must be non-empty, have no frontmatter, compose under
  `## General guidelines`, and pass Gitleaks.
- Invalid content fails without replacing the cache. An unavailable source or
  scanner uses a valid existing cache; without one, the command fails.
- Set `DOTFILES_AGENT_RULES_OFFLINE=1` to require the cache and skip fetching.

## Skill Sync

Run from the checkout after bootstrap has stored the profile:

```zsh
mise run agents:sync
mise run agents:update
```

- `sync` applies skills, plugins, then MCP servers.
- `update` also refreshes **all global skills**, including manually installed
  extras, and managed plugins.
- A failed global skill update leaves the completed manifest sync in place.
- These commands do not pull Git or refresh rule files.

Edit the selected layer under each manifest directory:

| Selection | Manifests | Implementation |
| --- | --- | --- |
| Skills | [skills/](../scripts/agents/skills/) | [sync.ts](../scripts/agents/sync.ts) |
| Plugins | [plugins/](../scripts/agents/plugins/) | [plugins.ts](../scripts/agents/plugins.ts) |
| MCP servers | [mcps/](../scripts/agents/mcps/) | [mcps.ts](../scripts/agents/mcps.ts) |

- Layers are `developer`, `workstation`, `devbox`, and `personal`; the
  [profile model](../chezmoi/.chezmoidata/profiles.json) selects their composition.
- Skills install for available Claude and Codex CLIs.
- Plugin and MCP entries can narrow `harnesses` to Claude, Codex, Cursor, Grok,
  or OpenCode.

Each sync keeps an ignored `scripts/agents/{skills,plugins,mcps}.lock.json`:

- Missing locks initialize ownership without removing existing installations.
- Subsequent runs remove dropped selections while preserving never-owned extras.
- Plugin and MCP removals awaiting a missing CLI remain owned until it returns.
- Failed installs or removals leave that sync's lock unchanged; earlier successful
  commands may already have changed the host. Fix the reported failure and rerun.

## Plugin Sync

- Plugin entries name a `marketplace` repository and plugin `name`.
  `marketplaceId` overrides the registered marketplace name when needed.
- The parser in [plugins.ts](../scripts/agents/plugins.ts) owns the schema.
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

- MCP entries set `name`, an HTTPS `url`, and optional `harnesses`.
- Sync preserves unrelated Cursor and OpenCode config fields.

Executor and other OAuth servers expire their sessions per harness. Check
every installed harness at once and get the repair command per row:

```zsh
mise run agents:doctor
```

| Harness | Re-authenticate |
| --- | --- |
| Claude Code | `claude mcp login <server>` (`--no-browser` over SSH) |
| Codex | `codex mcp login <server>` |
| Cursor | `cursor-agent mcp login <server>` in the project directory; tokens are per project, so seed a new checkout or worktree with `./scripts/agents/cursor-mcp-seed.ts` |
| OpenCode | `opencode mcp auth <server>` |
| Grok | `./scripts/agents/grok-mcp-login.ts <server>` (writes Grok 1.0.25's credential format; the TUI path is `/mcps`, select, `i`) |

Over SSH the callback port stays on the remote host: run the login under
`ssh -t` (Claude and Codex need a TTY) and forward the printed loopback port
with `ssh -L PORT:127.0.0.1:PORT` before opening the URL locally.

The doctor also reports Grok installation drift: every profile installs the
`grok-build` cask, so an npm global or a `~/.grok/bin` self-updater copy is
removed rather than kept.

## Verify

```zsh
mise run verify:domain agents
mise run verify:domain config
```
