# Contributing

## Prepare

- Install the [platform prerequisites](docs/bootstrap.md) (`git` and `mise`) and clone the repo.
- In a new checkout or worktree, install the verification tools at the template pins and prepare:

```zsh
mise --no-config use --global $(sed -nE 's/^(chezmoi|shellcheck|actionlint|gitleaks|trufflehog) = "([^"]+)"$/\1@\2/p' chezmoi/.chezmoitemplates/mise.toml)
./dotfiles prepare
export PATH="$(mise --no-config where node@"$(cat .node-version)")/bin:$PATH"
mise trust
```

`prepare` installs repository dependencies without applying a machine profile.

## Verify

Use the repository-local Vite+ CLI; no global installation is required:

```zsh
corepack pnpm exec vp check
corepack pnpm exec vp test
corepack pnpm exec knip
corepack pnpm exec vp fmt # format before committing
```

[vite.config.ts](vite.config.ts) owns formatting, type-aware lint, and Vitest.
[knip.ts](knip.ts) discovers CLI entrypoints and uses the adapter bundle's
inventory to check unused files, exports, and dependencies.
Chezmoi templates retain their native syntax and formatting. Tests import
`vite-plus/test`; entrypoints and integration fixtures still run directly in Node.

The full gate includes Vite+ plus platform and isolated-home checks:

```zsh
mise run verify:domain config # choose the affected domain
mise run verify:fast          # all deterministic checks
mise run verify               # also scan Git history for secrets
```

- [checks.json](verify/checks.json) owns domains, commands, and proof; focused
  runs omit `scope: "complete"` fixtures. Use `bootstrap`, `homebrew`, or
  `maintenance` for their respective operations; `profiles` covers profile contracts.
- Run live profile checks and [audits](docs/security-audits.md) only on the intended host and user.
- The optional [pre-push hook](verify/install-pre-push-hook.ts) checks outgoing commits for whitespace and conflict markers, including merge diffs against each parent; it does not run tests.

## Deliver

- Use Conventional Commits; update the [owning guide](README.md#guides) when behavior changes.
- PRs run [verification](.github/workflows/verify.yml) on macOS and Ubuntu plus secret scans. The Ubuntu job also previews the `developer` profile in a fresh home, resolves every Linux mise pin, and checks the rendered systemd units. Direct pushes require `mise run verify` locally; push workflows only evaluate releases.
- The Ubuntu job scopes `GITHUB_TOKEN` to the mise install step because unauthenticated runners exhaust the GitHub API budget, installs mise outside `~/.local/bin` so the converge tests keep their PATH stub in front, and renders the systemd units through `chezmoi cat` with a stub `node` in the runner's own home because chezmoi resolves `.chezmoi.homeDir` from the real user and `systemd-analyze` requires the `ExecStart` binary to exist.
- GitHub auto-merges eligible Renovate PRs after required CI passes. Add new mandatory checks to the ruleset; adding a workflow alone does not block merges. Admins retain direct pushes.
- Git tags own release versions; keep `package.json` private and unversioned. Commit rules: [.releaserc.json](.releaserc.json).
- Release commits use the `{user-id}+{slug}[bot]@users.noreply.github.com` email so GitHub links them to the app.
- [pnpm-workspace.yaml](pnpm-workspace.yaml) excludes the Effect RC packages from the minimum release age by bare name so version bumps touch only `package.json`.
- PR CI does not exercise the [release job](.github/workflows/verify.yml). Prove release-tool compatibility before updating its pins; holds live in [renovate.json](renovate.json).
