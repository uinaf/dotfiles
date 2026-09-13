# AGENTS.md

Public macOS and Ubuntu bootstrap framework. Keep portable setup here and
private machine state outside Git. `CLAUDE.md` links here; keep one authored agent guide.

## Layout

| Path | Responsibility |
| --- | --- |
| [dotfiles](dotfiles) | Public launcher |
| [mise.toml](mise.toml) | Public tasks |
| [bootstrap/](bootstrap/) | Per-user setup orchestration |
| [maintenance/](maintenance/) | Updates, scheduling, and cleanup |
| [homebrew/](homebrew/) | Brewfiles, composition, prefix management, and tests |
| [agents/](agents/) | Harness integration and manifests |
| [profiles/](profiles/) | Profile resolution and validation |
| [identity/](identity/) | Git, SSH, and age setup |
| [audit/](audit/) | Security audits |
| [verify/](verify/) | Repository gates and integration fixtures |
| [lib/](lib/) | Infrastructure shared across domains |
| [chezmoi/](chezmoi/) | Managed home files in Chezmoi's source layout |
| [docs/](docs/) | Operator procedures and rationale |

Keep implementations, configuration, and unit tests with their domain. Put
platform implementations under that domain's `darwin/` or `linux/` directory;
create neither until needed. Shared infrastructure belongs in `lib/` only
when multiple domains use it. Keep policy and inventories in code/config;
Markdown links to their owners and explains manual actions, recovery, and rationale.

## Work

- Check `git status --short --branch`; preserve unrelated changes.
- Identify the affected profile or repository-only tooling. Read the relevant [task guide](README.md#guides).
- Edit tracked sources at the domain owner above; preserve Chezmoi's required file layout.
- Keep repository-local instructions, secrets, and services with their consumer. Linux host packages and provisioning belong to the host, not here.
- Pin binary-release tools in the [mise templates](chezmoi/.chezmoitemplates/mise.toml) and their OS siblings. Keep them plain TOML for Renovate. [Homebrew](homebrew/) owns compiled packages, GUI apps, system services, and tools called by fixed privileged paths.
- Preserve standalone operation; do not require a companion workspace manager.
- Document manual setup when automation would need opaque app-state edits or machine-specific credential juggling.
- Before writing Effect code, read `node_modules/effect/AGENTS.md` completely and follow required links. Look up uncovered APIs in `node_modules/effect/src`.
- Write automation in TypeScript/Effect. Bundle installed client adapters so they run without the checkout or its dependencies. Keep shell limited to the pre-Node launcher and small native exec shims such as sudo askpass and Git signing.

## Boundaries

- Never commit secrets, keys, certificates, local config, generated env files, Tizen archives, or device keys. Never invent identities or credential references.
- Never copy or summarize coding-agent auth, approvals, sessions, caches, worktrees, browser profiles, app state, or secret-manager sessions into Git.
- Keep service tokens out of shell startup, plists, supervisor configs, and tracked or generated env files. Follow [identity provisioning](docs/identities.md).
- Keep examples public-safe. Installed names and prose are vendor-neutral; owner names appear only in real external coordinates. No private hosts, users, workspaces, repositories, or credential coordinates.

## Verify and Deliver

- Follow [Contributing](CONTRIBUTING.md) for setup and delivery.
- Run the affected domain, for example `mise run verify:domain config`. Direct pushes require `mise run verify`.
- Run live checks only on the matching host and user. PR CI runs the deterministic checks on macOS and Ubuntu; a successful push workflow proves release evaluation, not verification.
- Use Conventional Commits. Git tags own release versions; keep `package.json` private and unversioned.
- Update the owning doc when behavior changes. Prefer short bullets and commands; keep paragraphs for necessary rationale. Use proper-case headings and sentence-case prose. No emoji, marketing copy, or configuration narration.
