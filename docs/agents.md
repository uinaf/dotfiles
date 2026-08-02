# Agent Setup

The workstation and devbox profiles install machine-global instructions and
skills from `scripts/agents/`. The assistant profile does not install coding
agents, global instructions, or development skills.

## Sync

Run the profile-owned sync from the primary dotfiles checkout on `main`:

```zsh
mise run agents:sync
```

The equivalent direct entrypoint is `./scripts/agents/sync.sh`.

The sync fast-forwards the clean dotfiles checkout, generates
`scripts/agents/rules.final.md`, links it to installed Codex and Claude Code
entrypoints, and additively installs every entry in
`scripts/agents/skills.json`. It does not remove skills outside the manifest.
First-party skill source lives in [`uinaf/skills`](https://github.com/uinaf/skills).

The first run replaces symlinks managed by the former combined repository.
Regular files and foreign symlinks are rejected before global state changes.

## Local Rules

Put private machine-specific additions in ignored
`scripts/agents/rules.local.md`. Start local content at heading level three;
the generated file inserts it below `## Local Overrides`.

Do not edit `scripts/agents/rules.final.md` or installed copies under
`~/.agents/skills/`. Edit the tracked rule source here or the skill in its
owning repository, then rerun the sync.

## Verify

Repository verification exercises the typed sync in an isolated fixture. A
live workstation or devbox bootstrap runs the same sync after Codex, Claude
Code, Node, and pnpm are installed.
