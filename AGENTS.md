# AGENTS.md

Guidance for agents helping with this repo.

## Role

This is a vendor-neutral public macOS bootstrap framework for any person,
team, or organization. Help the user install tools, apply chezmoi-managed
dotfiles, configure local identity, and verify a machine without turning
private machine state into repository state.

Start with [README](README.md). Use [Bootstrap guide](docs/bootstrap.md) for
install steps, [User profiles](docs/profiles.md) for per-user role boundaries,
[Identity provisioning](docs/identities.md) for age, SSH, GitHub, and recovery
boundaries,
[Devbox setup](docs/devbox.md) for shared agent hosts, and
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
- Do not invent Git identities, signing keys, password-manager vault names,
  secret-manager project IDs, service tokens, or secret item references.
- Do not store service tokens or secret-manager machine credentials in Git,
  shell startup, launchd plists, process-compose YAML, or dotenv files.
- Keep examples public-safe. Avoid private machine names, vault item names, and
  identity context.

Machine-local secrets belong in explicit owner-only local storage or an
approved secret manager. Assistants use the SOPS/age and GitHub App contract in
[Identity provisioning](docs/identities.md). Coding devboxes may use the
Infisical contract in [Devbox setup](docs/devbox.md). Do not revive workspace
`.env` symlinks, generated secret files, or password-manager service-account
refresh stacks.

## Agent Operating Checklist

1. Run `git status --short --branch` before editing.
2. Identify the target profile: `workstation`, `devbox`, `assistant`, or
   repo-only docs/scripts.
3. Read only the relevant deep doc:
   - workstation or first-machine setup: [Bootstrap guide](docs/bootstrap.md)
   - user-role boundaries: [User profiles](docs/profiles.md)
   - age, SSH, GitHub, or recovery identity: [Identity provisioning](docs/identities.md)
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

For a human-operated Mac, follow [Workstation Mac](docs/bootstrap.md#workstation-mac).

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
Assistants use explicit workload authorship and unsigned commits. Configure
GitHub authentication with `configure-assistant-github-app.sh` only from
operator-supplied workload name, email, App identity, repository set, and
owner-only private key.
Headless assistant services use the system LaunchDaemon installer with an
owner-controlled runtime wrapper and a unique per-user gateway port. Keep
workload-specific secret paths and values outside this repository.

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
./scripts/verify/bootstrap.sh --profile workstation
./scripts/verify/bootstrap.sh --profile devbox
./scripts/verify/bootstrap.sh --profile assistant
```

For devbox users:

```zsh
./scripts/verify/devbox-services.sh
./scripts/audit/devbox.sh
```

For workstation security drift:

```zsh
./scripts/audit/workstation.sh
```

## Repo Rules

- Use Conventional Commits.
- Keep `Brewfile` minimal and identity-safe.
- Put the shared coding stack in `Brewfile.developer`.
- Put role-specific software in `Brewfile.workstation`, `Brewfile.devbox`, or
  `Brewfile.assistant`.
- Keep this repository standalone. Do not require, clone, install, invoke, or
  validate an agent framework or workspace manager.
- Keep portable interfaces vendor-neutral. Do not add `uinaf` or another owner
  name to installed paths, commands, config keys, template data, service labels,
  example identities, or prose that describes the framework. Owner names are
  allowed only for real external coordinates such as the upstream repository,
  package tap, security contact, copyright, or a bounded legacy migration.
- Keep Codex setup install-only here. Agent rules, skills, and workspace policy
  belong to whichever independent tools the machine owner chooses.
- Treat Git tags and GitHub Releases as the canonical version. Do not add a
  package manifest, checked-in version file, or release bump commit.
- Edit dotfiles in `chezmoi/`, not generated files in `$HOME`. Follow
  [Chezmoi source state](docs/chezmoi.md).
- Keep mise task and runtime scope split as documented in
  [Mise tasks](docs/mise.md).
- Update docs when scripts, profile behavior, audit behavior, or workflow names
  change.
- Follow the repo-doc voice: proper-case headings, sentence-case body,
  short direct prose, no emoji, no marketing copy.
