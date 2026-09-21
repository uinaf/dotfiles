# Agent Setup

The selected [profile](profiles.md) controls global rules, skills, plugins,
and MCP servers.

[Codex configuration](../agents/codex/config.ts) owns native configuration writes
and managed defaults. Bootstrap validates the profile and invokes it; gateway
configuration uses the same writer for enrollment and restoration. Gateway setup
preserves the selected Codex model and reasoning effort; model defaults belong
to Codex configuration.

[Gateway enrollment](../agents/gateway/enrollment.ts) owns input validation,
configuration, and rollback. Setup and maintenance preserve vendor logins.
The [gateway command](../bootstrap/configure-llm-gateway.ts) exposes apply,
check, and rollback operations.
Grok maintenance replaces only the managed gateway block, preserving newer
preferences. Adding or removing `grokBin` changes the client set in place, so
Codex and Claude keep everything added since enrollment. Rollback retains its
original enrollment snapshot semantics.
If a native TOML rewrite drops block comments, the exact configured gateway
sections are still recognized; conflicting values remain an error.

For T3 Code, set the Grok provider's binary path to
`~/.local/libexec/dotfiles/grok-t3` after gateway enrollment. Grok can print an
expired login status before refreshing its external credential during `models`.
The launcher retries that probe once; other commands execute the configured
`grokBin` directly. It preserves the token lifetime and reports genuine failures.
Switch back to `grok` when T3 handles the refreshed credential itself.
Also switch back before removing `grokBin` or rolling back gateway enrollment;
those operations do not change T3's manually selected binary path.

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

The [rule loader](../agents/rules.ts) owns remote validation and cache fallback.
[Local fragment validation](../agents/rules-local.ts) checks file ownership and permissions.
Invalid content leaves the existing cache intact. If fetching or scanning is
unavailable, setup needs a valid cache to continue. Set
`DOTFILES_AGENT_RULES_OFFLINE=1` to require cached rules without fetching.

## Skill Sync

Keep React, TanStack, shadcn, and Swift skills in the consuming repository. Use `slopskills` from
the [configured workflow plugin](../agents/plugins/developer.json) to select
and install them from repository evidence and the current task.
Global manifests retain shared workflows, codebase design and domain modeling
references, plus `effect-ts` and `ui-design`.
The plugin catalog supplies stack recommendations; explicit global selections
do not need duplicate repo-local installs. Keep licensed UI skill files out of Git.

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

The [profile model](../chezmoi/.chezmoidata/profiles.json) selects `agentLayers`;
each parser defines its manifest fields and supported harnesses.
An agent layer groups skill, plugin, and MCP selections for reuse across profiles.
The [MCP catalog](../agents/mcps/catalog.ts) validates and composes server
declarations for both sync and doctor. The [skill catalog](../agents/skills/catalog.ts)
validates declarations and ownership locks for sync and maintenance inventory.

### Local Overlay

Machine-specific skills and MCP servers that no shared layer should carry go
in an optional gitignored `agents/local.json`, the agent counterpart of
[`Brewfile.local`](profiles.md#local-homebrew-additions):

```json
{
  "skills": [{ "name": "local-skill", "source": "owner/skill-repository" }],
  "servers": [
    { "name": "local-mcp", "url": "https://example.invalid/mcp", "harnesses": ["claude"] }
  ]
}
```

- Both keys are optional and use the manifest entry shapes above; any other key
  fails. The [overlay reader](../agents/local.ts) requires a regular file owned
  by the current user without group or other write access.
- Entries are composed after the selected profile layers as a final `local`
  layer and can only add. An entry identical to a profile entry is ignored; the
  same name with a different shape fails, so a local file never silently
  changes a shared selection. Remove an entry by deleting it from the file.
- Overlay entries enter the same ownership lock, so dropping one removes it on
  the next sync like any dropped manifest entry. Sync, doctor, and the
  maintenance inventory all read the overlay; sync prints its path when used.
- Keep credentials out of it. OAuth state stays in each harness's own store.

Each sync keeps an ignored `agents/{skills,plugins,mcps}.lock.json`:

- Missing locks initialize ownership without removing existing installations.
- Subsequent runs remove dropped selections while preserving never-owned extras.
- Plugin and MCP removals awaiting a missing CLI remain owned until it returns.
- Failed installs or removals leave that sync's lock unchanged; earlier successful
  commands may already have changed the host. Fix the reported failure and rerun.

[Ownership planning](../agents/ownership.ts) computes plugin and MCP removals
and the next lock from selected entries, previous ownership, and available
harnesses. Syncs execute those removals and pass deferred entries back to the
plan; the lock is written only after successful apply and removal operations.
Plugin-specific ownership changes stay in
[plugin sync](../agents/plugins.ts).

## Plugin Sync

- OpenCode uses skill links from
  `~/.claude/plugins/marketplaces/<marketplaceId>/skills/`, so the Claude
  marketplace checkout must exist. Links follow its updates.
- Existing files or never-owned links at a selected skill name are reported
  rather than replaced. First sync does not prune links.

## MCP Sync

Executor and other OAuth servers expire their sessions per harness. Check
every installed harness at once and get the repair command per row:

```zsh
mise run agents:doctor
```

Use the repair command printed by [doctor.ts](../agents/doctor.ts).

Over SSH the callback port stays on the remote host: run the login under
`ssh -t` (Claude and Codex need a TTY) and forward the printed loopback port
with `ssh -L PORT:127.0.0.1:PORT` before opening the URL locally.

The doctor also reports Grok installation drift and prints the repair command.
Review it before removing a conflicting installation.

## Hindsight Memory

Personal profiles run `configure-hindsight` after agent sync.
[Hindsight setup](../agents/hindsight.ts) keeps the
`@vectorize-io/hindsight-coding-agents` runtime at the published version and
wires every installed managed harness through the upstream installer, which
rewrites only its own hook and MCP entries. The runtime's own `autoUpdate`
re-stages code but never rewires hosts; a harness whose MCP entry lacks
`HINDSIGHT_MCP_HARNESS` fails its handshake, so the step reinstalls whenever the
version or that wiring drifts. Daily maintenance repeats the step.

The server endpoint and token stay in owner-only `~/.hindsight/coding-agent.json`;
setup requires them and never writes them. Provision a new machine once:

```zsh
npx -y @vectorize-io/hindsight-coding-agents@latest install claude-code \
  --server self-hosted --api-url URL --api-token TOKEN
./bootstrap/configure-hindsight.ts
./bootstrap/configure-hindsight.ts --check
```

## Verify

The `agents` domain covers harness settings, gateways, rules, skills, plugins,
and MCP integration. The `config` domain covers the remaining managed-home
configuration.

```zsh
mise run verify:domain agents
mise run verify:domain config
```
