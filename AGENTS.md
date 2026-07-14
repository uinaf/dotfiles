# AGENTS.md

Guidance for agents helping with this repo.

## Role

This is a public Mac bootstrap repo for uinaf machines. Help the user install
tools, apply chezmoi-managed dotfiles, configure local identity, and verify a machine without
turning private machine state into repository state.

Start with [README](README.md). Use [Bootstrap guide](docs/bootstrap.md) for
install steps, [Devbox setup](docs/devbox.md) for shared agent hosts, and
[Agent readiness](docs/agent-readiness.md) for verification expectations. Use
[Chezmoi source state](docs/chezmoi.md) for dotfile changes and
[Mise tasks](docs/mise.md) for task/runtime boundaries.

`CLAUDE.md` is a symlink to this file. Keep `AGENTS.md` as the only authored
agent guide.

## Hard Boundaries

- Do not commit secrets, tokens, private keys, certificates, Tizen archives,
  machine-local config, or generated env files.
- Do not back up, copy, link, or summarize full Codex config, Browser
  approvals, auth files, sessions, caches, worktrees, or app state.
- Do not invent Git identities, signing keys, 1Password vault names, Infisical
  project/workspace IDs, service tokens, or secret item references.
- Do not store service tokens or Infisical machine credentials in Git, shell
  startup, launchd plists, process-compose YAML, or dotenv files.
- Keep examples public-safe. Avoid private machine names, vault item names, and
  identity context.

Machine-local secrets belong in explicit owner-only local storage or an
approved secret manager login. For shared agent hosts, use the current contract
in [Devbox setup](docs/devbox.md): humans may use 1Password and Infisical;
agents use Infisical machine identity auth only for secrets/env access. Do not
revive workspace `.env` symlinks, devbox-env generated files, or 1Password
service-account refresh stacks.

## Agent Operating Checklist

1. Run `git status --short --branch` before editing.
2. Identify the target profile: `personal`, `devbox`, or repo-only docs/scripts.
3. Read only the relevant deep doc:
   - personal or first-machine setup: [Bootstrap guide](docs/bootstrap.md)
   - shared agent host: [Devbox setup](docs/devbox.md)
   - dotfile source changes: [Chezmoi source state](docs/chezmoi.md)
   - mise task or runtime changes: [Mise tasks](docs/mise.md)
   - audits or secret boundaries: [Security audits](docs/security-audits.md)
   - CI and GitHub workflows: [GitHub pipelines](docs/github-pipelines.md)
4. Keep top-level docs short; put operational detail under `docs/`.
5. Use repo scripts and `chezmoi/` source state as the source of truth. Do not replace them with one-off
   shell snippets unless you are diagnosing a failure.
6. If automation starts requiring brittle app-state edits, opaque config
   surgery, or machine-specific juggling, stop automating it. Document the
   manual step under the relevant guide and ask the human or active agent to
   apply it locally.
7. Verify with the narrowest useful command, then run the final repo gate before
   committing.

## Setup Flow

For a human-operated Mac, follow [Personal Mac](docs/bootstrap.md#personal-mac).

For a shared agent host, follow [Devbox Mac](docs/bootstrap.md#devbox-mac) and
then [Devbox setup](docs/devbox.md). Devbox commit signing is expected and must
be configured from explicit values. Headless devboxes should usually use a
human-provisioned local SSH key file, because GUI SSH agent sockets may not
exist in SSH sessions:

```zsh
GIT_USER_NAME='Devbox Name' \
GIT_USER_EMAIL='devbox@example.com' \
GIT_SIGNING_KEY="$HOME/.ssh/devbox-key" \
  ./scripts/bootstrap/configure-git.sh --profile devbox --non-interactive
```

Commit signing supports one unattended mode: an unencrypted local SSH private
key plus the agentless signer installed by `scripts/bootstrap/install.sh`.

Do not put identity-specific values in tracked files. `configure-git.sh` writes
them to `~/.gitconfig.local`. On devboxes, use the human-provisioned local SSH
key file for GitHub SSH auth; `configure-git.sh` writes the matching
`~/.ssh/github.config` override when the signing key is a local path.

## Verification

Before committing repo changes:

```zsh
./scripts/verify/repo.sh
```

For fast local script loops before the final check:

```zsh
./scripts/verify/repo.sh --skip-security
```

To install the same fast gate as a local pre-push hook:

```zsh
./scripts/bootstrap/install-git-hooks.sh
```

For a live machine that should use these dotfiles:

```zsh
./scripts/verify/bootstrap.sh --profile personal
./scripts/verify/bootstrap.sh --profile devbox
```

For devbox users:

```zsh
./scripts/verify/devbox-services.sh
./scripts/audit/devbox.sh
```

For personal security drift:

```zsh
./scripts/audit/personal.sh
```

## Repo Rules

- Use Conventional Commits.
- Keep `Brewfile` shared and profile-neutral.
- Put laptop-only apps in `Brewfile.personal`.
- Put shared agent-host and devbox tools in `Brewfile.devbox`.
- Keep Codex setup install-only here; agent rule links belong to
  [uinaf/agents](https://github.com/uinaf/agents).
- Edit dotfiles in `chezmoi/`, not generated files in `$HOME`. Follow
  [Chezmoi source state](docs/chezmoi.md).
- Keep mise task and runtime scope split as documented in
  [Mise tasks](docs/mise.md).
- Update docs when scripts, profile behavior, audit behavior, or workflow names
  change.
- Follow the uinaf repo-doc voice: proper-case headings, sentence-case body,
  short direct prose, no emoji, no marketing copy.
