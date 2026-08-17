# Agent Setup

personal-workstation, personal-devbox, workstation, and devbox profiles install
machine-global instructions and skills. The assistant profile installs
neither.

## Global Rules

Chezmoi owns the shared rules and agent entrypoints:

| Source | Target |
| --- | --- |
| `chezmoi/private_AGENTS.md.tmpl` | `~/AGENTS.md` |
| `chezmoi/private_dot_claude/symlink_CLAUDE.md` | `~/.claude/CLAUDE.md` |
| `chezmoi/private_dot_codex/symlink_AGENTS.md` | `~/.codex/AGENTS.md` |

Preview and apply rule changes with the normal dotfile commands:

```zsh
./dotfiles diff workstation
./dotfiles apply workstation
```

`~/AGENTS.md` is the private canonical file. Claude and Codex link directly to
it. For developer profiles, apply backs up and removes the retired
`~/.agents/AGENTS.md` while leaving `~/.agents/skills` intact. The dotfile
wrapper also backs up conflicting files or broken links before chezmoi
converges them.

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

The start and end fragments own their heading structure. The built-in rules
begin at `## General Guidelines`, so a start fragment can provide the document
title and an end fragment can add sibling sections. Chezmoi reads each fragment
literally, trims surrounding whitespace, joins non-empty layers with one blank
line, and omits absent or blank files.

Keep each file or its symlink target private to the local user, then preview and
apply the selected profile. Symlinks are supported; their resolved targets must
be regular files owned by the current user with no group or other permissions.

## Rule Design

The shared layer is one portable behavior contract, not a stack of prompts for
individual models. Keep personal identity and private routing in the local
fragments. Keep model selection, reasoning effort, and verbosity settings in
the harness that owns them.

Use prompting pages to tune behavior and system or model cards to validate
capability and risk boundaries when a model change exposes a measured gap:

| Model | First-party guidance |
| --- | --- |
| GPT-5.6 Sol | [Prompting best practices](https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6) and [system card](https://deploymentsafety.openai.com/gpt-5-6) |
| Grok 4.6 | [Release guidance](https://x.ai/news/grok-4-6) and [model reference](https://docs.x.ai/developers/models/grok-4.6) |
| Claude Opus 5 | [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5) |
| Claude Fable 5 | [Prompting Claude Fable 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5) and [system card](https://www-cdn.anthropic.com/2f9323abbcc4abe219577539efe19a623c9ca2bd/Claude%20Fable%205%20%26%20Claude%20Mythos%205%20System%20Card.pdf) |

When maintaining the shared rules:

- Add a rule for a recurring observed failure, user preference, authority
  boundary, or required repository contract.
- State each behavior once. Remove repeated reminders and examples when a
  shorter instruction produces the same result.
- Escalate a rule only after sessions observably violate it: replace
  self-graded adjectives with numeric limits, name the anti-pattern, or keep
  at most one before/after exemplar. Remove the escalation when it stops
  paying for itself.
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

The direct entrypoint is `./scripts/agents/sync.ts`. It reads the secure stored
profile marker, composes the profile's layer manifests, and installs those
skills for available Codex and Claude Code CLIs. It does not
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

Shared first-party skills live in
[`uinaf/agent-skills`](https://github.com/uinaf/agent-skills).
Personal CLI-backed skills retain their owning repositories. Layer manifests are named for the profile axes they serve:
`scripts/agents/skills/{developer,workstation,devbox,personal}.json`. A profile
composes its axes (personal-workstation is developer + workstation + personal),
and an identical entry selected by more than one axis installs once.

## Plugin Sync

`agents:sync` and `agents:update` also apply the plugin manifests through
`./scripts/agents/plugins.ts`. The layering matches skills:
`scripts/agents/plugins/{developer,workstation,devbox,personal}.json`, keyed by
the same profile marker and composed the same way.

Each entry sets `marketplace` as `owner/repo` and `name` as the plugin. Optional
`harnesses` narrows an entry to a subset of `claude`, `codex`, and `cursor`; the
default is all three. Optional `marketplaceId` overrides the registered
marketplace name when it differs from the repository name.

Sync adds each marketplace once per harness, then installs with
`claude plugin install` and `codex plugin add`. Both are idempotent, and
`codex plugin add` is what records `enabled = true` in `~/.codex/config.toml`,
so plugin sync never edits that file itself. Cursor exposes no non-interactive
install, so sync adds the marketplace and prints a one-line notice to finish in
`/plugins`. A harness whose CLI is absent is skipped with a notice.

## Verify

```zsh
mise run verify:domain config
mise run verify:domain agents
```

Rule fixtures cover clean and repeated applies, local Markdown files and
symlinks, permissions and ownership, workload isolation, explicit diffs, and
conflicts. Skill fixtures cover install, update, conflict, removal, and
ownership without touching rules or Git.
