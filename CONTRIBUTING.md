# Contributing

## Prepare

- Install the [Mac prerequisites](docs/bootstrap.md) and clone the repo.
- In a new checkout or worktree:

```zsh
brew install mise actionlint chezmoi shellcheck
./dotfiles prepare
export PATH="$(mise --no-config where node@"$(cat .node-version)")/bin:$PATH"
mise trust
```

`prepare` installs repository dependencies without applying a machine profile.

## Verify

```zsh
mise run verify:domain config # choose the affected domain
mise run verify:fast          # all deterministic checks
mise run verify               # also scan Git history for secrets
```

- Domains: [mise.toml](mise.toml). Checks: [checks.json](scripts/verify/checks.json).
- Run live profile checks and [audits](docs/security-audits.md) only on the intended Mac or user.
- The optional [pre-push hook](scripts/verify/install-pre-push-hook.ts) checks outgoing commits for whitespace and conflict markers; it does not run tests.

## Deliver

- Use Conventional Commits; update the [owning guide](README.md#guides) when behavior changes.
- PRs run verification and scans. Direct pushes require `mise run verify` locally; push workflows only evaluate releases.
- GitHub auto-merges eligible Renovate PRs after required CI passes. Add new mandatory checks to the ruleset; adding a workflow alone does not block merges. Admins retain direct pushes.
- Git tags own release versions; keep `package.json` private and unversioned. Commit rules: [.releaserc.json](.releaserc.json).
- PR CI does not exercise the [release job](.github/workflows/verify.yml). Prove release-tool compatibility before updating its pins; holds live in [renovate.json](renovate.json).
