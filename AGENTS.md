# AGENTS.md

Guidance for agents changing this repository.

## Role

This is a public, vendor-neutral macOS bootstrap framework. Keep portable
machine setup in the repository and private machine state outside it.

| Task | Read first |
| --- | --- |
| Install or update a Mac | [Bootstrap](docs/bootstrap.md) |
| Change profile packages or role boundaries | [User profiles](docs/profiles.md) |
| Change age, Git, SSH, GitHub, or recovery behavior | [Identity provisioning](docs/identities.md) |
| Change shared-host services or secret consumers | [Devbox setup](docs/devbox.md) |
| Change global agent rules or skills | [Agent setup](docs/agents.md) |
| Change dotfile source state | [Chezmoi](docs/chezmoi.md) |
| Change tasks or runtime pins | [Mise](docs/mise.md) |
| Change audits or secret boundaries | [Security audits](docs/security-audits.md) |
| Change CI or releases | [GitHub pipelines](docs/github-pipelines.md) |

`CLAUDE.md` is a symlink to this file. Keep `AGENTS.md` as the only authored
repository guide.

## Hard Boundaries

- Never commit secrets, tokens, private keys, certificates, machine-local
  config, generated env files, Tizen archives, or device keys.
- Never copy or summarize Codex auth, approvals, sessions, caches, worktrees,
  browser profiles, app state, or secret-manager sessions into the repository.
- Never invent identity values, signing keys, vault names, secret item
  references, machine credentials, or service tokens.
- Keep examples public-safe: no private hosts, users, workspaces, repositories,
  identities, or credential coordinates.
- Keep service tokens out of shell startup, launchd plists, supervisor configs,
  tracked dotenv files, and generated refresh files.

Use the SOPS/age and GitHub App contracts in
[Identity provisioning](docs/identities.md). Repository-specific secrets,
instructions, skills, and service definitions stay with their owning
repository.

## Workflow

1. Run `git status --short --branch` and preserve unrelated work.
2. Identify the affected profile: `personal-workstation`, `personal-devbox`, `workstation`,
   `devbox`, `assistant`, `service`, or repository-only tooling.
3. Read the smallest owning guide from the table above.
4. Change tracked sources, not generated home-directory state.
5. Update the owning documentation when behavior, paths, or commands change.
6. Run the focused domain that owns the change. CI runs the complete graph.

Prefer repository scripts over one-off shell snippets. If automation requires
opaque app-state edits or machine-specific credential juggling, document the
manual step in the owning guide instead.

## Verify

```zsh
./scripts/verify/repo.sh --list
./scripts/verify/repo.sh --domain config   # example; select the owning domain
./scripts/verify/repo.sh --skip-security # complete deterministic graph
./scripts/verify/repo.sh                 # complete graph plus secret scans
```

Run live checks only on a machine that should satisfy the selected profile:

```zsh
./scripts/verify/bootstrap.sh --profile workstation
./scripts/verify/bootstrap.sh --profile personal-workstation
./scripts/verify/bootstrap.sh --profile personal-devbox
./scripts/verify/bootstrap.sh --profile devbox
./scripts/verify/bootstrap.sh --profile assistant
./scripts/verify/bootstrap.sh --profile service
./scripts/verify/devbox-services.sh
./scripts/audit/workstation.sh
./scripts/audit/devbox.sh
```

## Repository Contracts

- Use Conventional Commits.
- Keep `Brewfile` limited to capabilities required by every profile, including
  Chrome and `gh`. Shared coding tools belong in `Brewfile.developer`;
  role-specific software belongs in
  `Brewfile.workstation`, `Brewfile.personal`, `Brewfile.devbox`,
  `Brewfile.assistant`, or `Brewfile.service`.
- Edit dotfiles under `chezmoi/`, not the generated files in `$HOME`.
- Keep machine-global coding-agent rules and additive skill selection under
  `scripts/agents/`. Assistant and service profiles do not install them.
- Keep the repository standalone. Do not require a workspace manager or a
  companion repository.
- Keep installed paths, commands, config keys, service labels, and portable
  prose vendor-neutral. Owner names are allowed only for real external
  coordinates such as this repository, a tap, or the security contact.
- Treat Git tags and GitHub Releases as the version boundary. Do not add a
  package manifest, checked-in version file, or release bump commit.
- Use proper-case headings, sentence-case prose, short direct paragraphs, no
  emoji, and no marketing copy.
