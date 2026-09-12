# AGENTS.md

Public macOS and Ubuntu bootstrap framework. Keep portable setup here and
private machine state outside Git. `CLAUDE.md` links here; keep one authored agent guide.

## Work

- Check `git status --short --branch`; preserve unrelated changes.
- Identify the affected profile or repository-only tooling. Read the relevant [task guide](README.md#guides).
- Edit tracked sources: `chezmoi/` for home files, `scripts/agents/` for global agent setup, `scripts/bootstrap/` for installation.
- Keep repository-local instructions, secrets, and services with their consumer.
- Pin command-line tools with binary releases in `chezmoi/.chezmoitemplates/mise.toml` (plain TOML; Renovate parses it). Keep `Brewfile` for what needs a compiler, a GUI, a system service, or a fixed privileged path; role packages belong in `Brewfile.workstation`, `Brewfile.personal`, or `Brewfile.devbox`.
- Preserve standalone operation; do not require a companion workspace manager.
- Document manual setup when automation would need opaque app-state edits or machine-specific credential juggling.
- Before writing Effect code, read `node_modules/effect/AGENTS.md` completely and follow required links. Look up uncovered APIs in `node_modules/effect/src`.

## Boundaries

- Never commit secrets, keys, certificates, local config, generated env files, Tizen archives, or device keys. Never invent identities or credential references.
- Never copy or summarize coding-agent auth, approvals, sessions, caches, worktrees, browser profiles, app state, or secret-manager sessions into Git.
- Keep service tokens out of shell startup, plists, supervisor configs, and tracked or generated env files. Follow [identity provisioning](docs/identities.md).
- Keep examples public-safe. Installed names and prose are vendor-neutral; owner names appear only in real external coordinates. No private hosts, users, workspaces, repositories, or credential coordinates.

## Verify and Deliver

- Follow [Contributing](CONTRIBUTING.md) for setup and delivery.
- Run the affected domain, for example `mise run verify:domain config`. Direct pushes require `mise run verify`.
- Run live checks only on the matching Mac and user. A successful push workflow proves release evaluation, not verification.
- Use Conventional Commits. Git tags own release versions; keep `package.json` private and unversioned.
- Update the owning doc when behavior changes. Prefer short bullets and commands; keep paragraphs for necessary rationale. Use proper-case headings and sentence-case prose. No emoji, marketing copy, or configuration narration.
