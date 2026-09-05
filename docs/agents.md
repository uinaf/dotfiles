# Agent Setup

personal-workstation, personal-devbox, workstation, and devbox profiles install
machine-global instructions and skills. Non-developer profiles install
neither.

## Global Rules

Configured remote sources own the shared layer. Dotfiles fetches them into
machine-local state, and Chezmoi owns the agent entrypoints:

| Source | Role or target |
| --- | --- |
| `scripts/agents/rules.json` | Ordered HTTPS sources for the shared layer |
| `${XDG_STATE_HOME:-~/.local/state}/dotfiles/agent-rules.md` | Ignored machine-local cache for offline use |
| `chezmoi/private_AGENTS.md.tmpl` | Composes the cache and private fragments into `~/AGENTS.md` |
| `chezmoi/private_dot_claude/symlink_CLAUDE.md` | `~/.claude/CLAUDE.md` |
| `chezmoi/private_dot_codex/symlink_AGENTS.md` | `~/.codex/AGENTS.md` |

Preview and apply rule changes with the normal dotfile commands:

```zsh
./dotfiles diff workstation
./dotfiles apply workstation
```

A developer preview or apply fetches every configured source in order before
Chezmoi renders it. The refresh updates the machine-local cache only when:

- Every source is non-empty and has no frontmatter.
- The combined document starts at `## General guidelines`.
- `gitleaks` reports no possible secrets.

An unavailable source or secret scanner leaves an existing cache in place and
prints one warning. The first run fails when no valid cache can cover an
unavailable refresh. Invalid fetched content fails without changing the cache.
Set `DOTFILES_AGENT_RULES_OFFLINE=1` to skip fetching and require the cache.

- `~/AGENTS.md` is the private canonical target; Claude and Codex link directly to
  it.
- Managed user settings disable Claude Code and Codex native auto-memory. Keep
  durable rules in `~/AGENTS.md` or the owning repository instead.
- For developer profiles, apply removes the retired `~/.agents/AGENTS.md` while
  leaving `~/.agents/skills` intact.
- The three generated rule paths above and the retired path are replaced
  without backups. The dotfile wrapper still backs up unrelated conflicting
  files or broken links before chezmoi converges them.

### Private Rules

Optional machine-specific text comes from two Markdown fragments outside this
repository:

| Fragment | Position |
| --- | --- |
| `~/.config/dotfiles/agents.start.md` | Before the shared rules |
| `~/.config/dotfiles/agents.end.md` | After the shared rules |

For example, an end fragment can add machine-specific routing:

```markdown
## Machine-specific rule

Add private instructions here.
```

- The start and end fragments own their heading structure.
- The shared rules begin at `## General guidelines`, so a start fragment can
  provide the document title and an end fragment can add sibling sections.
- Chezmoi reads each fragment literally, trims surrounding whitespace, joins
  non-empty layers with one blank line, and omits absent or blank files.
- Keep each file or its symlink target private to the local user, then preview
  and apply the selected profile.
- Symlinks are supported. Their resolved targets must be regular files owned by
  the current user with no group or other permissions.

## Rule Design

The shared layer is one portable behavior contract, not a stack of prompts for
individual models.

- Keep personal identity and private routing in the local fragments.
- Keep model selection, reasoning effort, and verbosity settings in the harness
  that owns them.

Use prompting pages to tune behavior and system or model cards to validate
capability and risk boundaries when a model change exposes a measured gap:

| Model | First-party guidance |
| --- | --- |
| GPT-5.6 Sol | [Prompting best practices](https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6) and [system card](https://deploymentsafety.openai.com/gpt-5-6) |
| Grok 4.6 | [Release guidance](https://x.ai/news/grok-4-6) and [model reference](https://docs.x.ai/developers/models/grok-4.6) |
| Claude Opus 5 | [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5) |
| Claude Fable 5.1 | [Prompting Claude Fable 5.1](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1) and [model overview](https://platform.claude.com/docs/en/models/fable-5-1/overview) |

When maintaining the shared rules:

- Add a rule for a recurring observed failure, user preference, authority
  boundary, or required repository contract.
- State each behavior once. Remove repeated reminders and examples when a
  shorter instruction produces the same result.
- Escalate a rule only after sessions observably violate it: replace
  self-graded adjectives with the concrete outcome wanted, or keep at most
  one before/after exemplar. Prefer outcome framing to numeric caps. Remove
  the escalation when it stops paying for itself.
- Specify the deliverable, scope, authority, evidence, and completion boundary;
  leave hidden reasoning style to the model and harness.
- Prefer positive operating instructions over long inventories of unwanted
  model behavior.
- Re-evaluate rules after a model change and remove scaffolding that no longer
  improves representative tasks.

## Skill Sync

Run the profile-owned skill sync from any checkout:

```zsh
mise run agents:sync
mise run agents:update
```

The direct entrypoint is `./scripts/agents/sync.ts`:

- Reads the secure stored profile marker.
- Composes the profile's layer manifests.
- Installs those skills for available Codex and Claude Code CLIs.
- Does not pull Git or manage rule files.

The ignored `scripts/agents/skills.lock.json` records the last manifest applied
by this checkout:

- Sync removes skills dropped from that lock while preserving global skills it
  never owned.
- Removing an owned skill also removes its links from every agent configured by
  the skills CLI.
- When the lock is missing, sync installs the current manifest and initializes
  ownership without removing anything.
- With no supported agent and no lock, sync skips installation and ownership
  initialization.

`--update` runs `skills update -g` after manifest sync:

- It refreshes all global skills, including extras the lock never owned.
- Manifest failures skip the updater.
- An updater failure leaves the completed manifest sync in place.

Manifest layout:

- Shared first-party skills live in
  [`uinaf/agent-skills`](https://github.com/uinaf/agent-skills).
- Personal CLI-backed skills retain their owning repositories.
- Layer manifests are named for the profile axes they serve:
  `scripts/agents/skills/{developer,workstation,devbox,personal}.json`.
- A profile composes its axes; `personal-workstation` is developer plus
  workstation plus personal.
- An identical entry selected by more than one axis installs once.

## Plugin Sync

`agents:sync` and `agents:update` also apply the plugin manifests through
`./scripts/agents/plugins.ts`. The layering matches skills:
`scripts/agents/plugins/{developer,workstation,devbox,personal}.json`, keyed by
the same profile marker and composed the same way.

Each manifest entry uses these fields:

| Field | Meaning |
| --- | --- |
| `marketplace` | Source repository as `owner/repo` |
| `name` | Plugin name |
| `harnesses` | Optional subset of `claude`, `codex`, `cursor`, `grok`, and `opencode`; the default is all five |
| `marketplaceId` | Optional override when the registered marketplace name differs from the repository name |
| `cursorMode` | Optional Cursor install path: `marketplace` (the default) or `skills`, which links the plugin's skill directories instead of importing the marketplace and requires both `cursor` and `claude` selection |

Sync adds each marketplace once per harness, then installs it:

| Harness | Install path |
| --- | --- |
| Claude | `claude plugin install`, idempotent |
| Codex | `codex plugin add`, idempotent. It records `enabled = true` in `~/.codex/config.toml`, so plugin sync never edits that file itself |
| Cursor | No non-interactive install exists, so sync adds the marketplace and prints a one-line notice to finish in `/plugins`. Managed Cursor workspaces can block third-party imports outright; a `cursorMode: "skills"` entry skips the marketplace and uses skill links instead |
| Grok | `grok plugin install <owner/repo> --trust` per source repository. Re-installing an installed source fails, so sync consults `grok plugin list` first |

`--update` (used by `agents:update`) keeps that install/convergence, then refreshes
managed plugins where the harness has a non-interactive update:

| Harness | Update path |
| --- | --- |
| Claude | `claude plugin update <name>@<marketplace> -y` after install, one selected plugin at a time |
| Codex | `codex plugin marketplace upgrade <marketplaceId>` after add and before `plugin add` |
| Grok | `grok plugin update <name>` for an already-installed source whose list names a managed plugin. An installed source with no matching name is reported as not refreshed instead of treated as current |
| Cursor, OpenCode | no plugin update command; native skill links keep following the Claude marketplace checkout |

A harness whose CLI is absent is skipped with a notice.

The ignored `scripts/agents/plugins.lock.json` records the last plugin
selection applied by this checkout:

- Sync uninstalls plugins dropped from that lock while preserving plugins it
  never owned.
- The lock records only harnesses whose CLI was present, leftovers that could
  not be removed yet, and previously owned still-selected harnesses whose CLI
  is temporarily absent.
- First apply never prunes or replaces native-skill links.
- A plugin that stays selected but loses a harness is removed from that
  harness only.
- Claude uses `plugin uninstall -y`, Codex uses `plugin remove`, and Grok uses
  `plugin uninstall --confirm`.
- Cursor marketplace disable stays interactive and remains owned until a later
  sync can confirm it is gone; native-skills and OpenCode links are pruned
  after ownership exists, including when the layer becomes empty.
- When the lock is missing, sync installs the current selection and
  initializes ownership without removing anything.
- With no supported harness and no lock, sync skips ownership initialization.
- A missing harness CLI during removal keeps that plugin and harness in the
  lock until the CLI returns.
- Installation or removal failures leave the lock unchanged.

Two cases install through skill links instead of plugin commands: OpenCode
always (its plugin API carries hooks and tools, not skills), and Cursor for
entries with `cursorMode: "skills"`. Both share one link mechanism:

- Source: `~/.claude/plugins/marketplaces/<marketplaceId>/skills/*` in the
  Claude Code marketplace checkout; only directories containing `SKILL.md`
  are linked.
- Target: the harness's native skill discovery, `~/.config/opencode/skills/`
  for OpenCode and `~/.cursor/skills/` for Cursor.
- Links follow marketplace updates automatically.
- After apply and leftover removal succeed, links from previously owned
  marketplace checkouts that no longer match a selected plugin are pruned,
  including links left behind when a plugin changes `cursorMode`. Never-owned
  marketplace-tree links stay. A newly selected marketplace that collides with
  an existing link is reported instead of replaced.
- A non-symlink entry at a managed name is reported instead of replaced.
- The Claude harness therefore syncs first; a missing checkout is a reported
  failure.

## MCP Sync

`agents:sync` and `agents:update` finish with `./scripts/agents/mcps.ts`, which
converges remote MCP servers across the same five harnesses. The layering
matches skills and plugins:

- `scripts/agents/mcps/{developer,workstation,devbox,personal}.json`, keyed by
  the same profile marker and composed the same way.
- Each entry sets a `name` and an `https` `url`.
- Optional `harnesses` narrows the entry.

Convergence differs per harness:

| Harness | Behavior |
| --- | --- |
| Grok, OpenCode | `mcp add` upserts plain config, so sync re-adds every selected server |
| Claude | `claude mcp add` refuses an existing name, so sync converges through `claude mcp get`: a matching URL is a no-op, anything else is removed and re-added at user scope |
| Codex | `codex mcp add` upserts config, then probes the server and can start an interactive OAuth login. Sync gets first and skips a matching URL. An add whose config landed before the login step failed is reported as pending `codex mcp login`, not a failure |
| Cursor | `cursor-agent` has no add subcommand, so sync merges `~/.cursor/mcp.json` directly, updating only the managed entries' `url` and preserving everything else in the file |

The ignored `scripts/agents/mcps.lock.json` records the last server names
applied by this checkout:

- Sync removes servers dropped from that lock while preserving servers it
  never owned.
- The lock records only harnesses whose CLI was present, leftovers that could
  not be removed yet, and previously owned still-selected harnesses whose CLI
  is temporarily absent.
- A server that stays selected but loses a harness is removed from that
  harness only.
- Claude and Grok use `mcp remove -s user`. Codex uses `mcp remove`.
- Cursor deletes owned keys from `~/.cursor/mcp.json`. OpenCode has no remove
  subcommand, so sync deletes owned keys from `~/.config/opencode/opencode.jsonc`
  or `opencode.json` and leaves every other key untouched.
- When the lock is missing, sync applies the current selection and initializes
  ownership without removing anything.
- With no supported harness and no lock, sync skips ownership initialization.
- A missing harness CLI during removal keeps that server and harness in the
  lock until the CLI returns.
- Add or removal failures leave the lock unchanged.

Executor is not selected for Grok while its bundled `rmcp` is older than 2.2.0;
earlier releases reject same-origin MCP paths during OAuth discovery. Check with
`strings "$(command -v grok)" | grep -o 'rmcp-[0-9.]*'` before enabling the
entry.

## Verify

```zsh
mise run verify:domain config
mise run verify:domain agents
```

- Rule-source fixtures cover strict config, ordered composition, rejected
  content, atomic machine-local cache updates, and offline fallback.
- Rule-composition fixtures cover clean and repeated applies, local Markdown
  files and symlinks, literal cache content, permissions and ownership,
  workload isolation, explicit diffs, and conflicts.
- Skill fixtures cover install, update, conflict, removal, and ownership without
  touching rules or Git.
- Plugin and MCP fixtures cover the same ownership contract: first-run lock
  init, drop-from-lock removal, missing-CLI leftovers, and failed apply or
  remove leaving the lock unchanged.
