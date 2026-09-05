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

## Learning More About Effect

This repository uses the Effect TypeScript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect APIs and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

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
   `devbox`, or repository-only tooling.
3. Read the smallest owning guide from the table above.
4. Change tracked sources, not generated home-directory state.
5. Update the owning documentation when behavior, paths, or commands change.
6. Run the focused domain that owns the change. CI runs the complete graph.

Prefer repository scripts over one-off shell snippets. If automation requires
opaque app-state edits or machine-specific credential juggling, document the
manual step in the owning guide instead.

## Verify

```zsh
mise run verify:domain config # example; select the owning domain
mise run verify:fast          # complete deterministic graph
mise run verify               # complete graph plus secret scans
```

Run live checks only on a machine that should satisfy the selected profile:

```zsh
./scripts/verify/bootstrap.ts --profile workstation
./scripts/verify/bootstrap.ts --profile personal-workstation
./scripts/verify/bootstrap.ts --profile personal-devbox
./scripts/verify/bootstrap.ts --profile devbox
./scripts/verify/devbox-services.ts
mise run audit workstation
mise run audit devbox
```

## Repository Contracts

- Use Conventional Commits.
- Keep `Brewfile` limited to capabilities required by every profile, including
  Chrome and `gh`. Shared coding tools belong in `Brewfile.developer`;
  role-specific software belongs in
  `Brewfile.workstation`, `Brewfile.personal`, or `Brewfile.devbox`.
- Edit dotfiles under `chezmoi/`, not the generated files in `$HOME`.
- Keep machine-global coding-agent rules and additive skill selection under
  `scripts/agents/`.
- Keep the repository standalone. Do not require a workspace manager or a
  companion repository.
- Keep installed paths, commands, config keys, service labels, and portable
  prose vendor-neutral. Owner names are allowed only for real external
  coordinates such as this repository, a tap, or the security contact.
- Treat Git tags and GitHub Releases as the version boundary. Do not add a
  package manifest, checked-in version file, or release bump commit.
- Use proper-case headings and sentence-case prose. Prefer bullets, tables, and
  short labeled lines over paragraphs; keep a paragraph for rationale only. No
  emoji and no marketing copy.
