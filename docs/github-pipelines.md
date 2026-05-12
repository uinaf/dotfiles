# GitHub Pipelines

This repo uses GitHub Actions for repository verification and secret scanning.
It does not deploy a running service or publish a versioned package.

## Current Workflows

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| Verify | push to `main`, pull request, manual dispatch | Run repository checks that do not need secrets: shell syntax, ShellCheck, Actionlint, diff hygiene, and agent-entrypoint checks. |
| Secret scanning | push to `main`, pull request, weekly schedule, manual dispatch | Run Gitleaks and TruffleHog with full Git history available. |

The local canonical command remains:

```zsh
./scripts/bootstrap/verify-repo.sh
```

The Verify workflow runs `./scripts/bootstrap/verify-repo.sh --skip-security`
because the dedicated Secret scanning workflow performs the CI scanner pass.

## Deploy Pipeline

There is no deploy pipeline for this repo. Dotfiles changes are consumed by
humans and devbox users pulling the repo and running bootstrap scripts.

If this repo ever gains a running service, add a separate deploy pipeline with
this shape:

1. detect changed deploy lanes
2. verify and build immutable artifacts
3. run e2e against the built artifact
4. deploy through a protected GitHub Environment
5. run a separate read-only smoke job without deploy credentials

Deploy jobs must use non-cancellable concurrency per environment and lane.
Deploy credentials must be environment-scoped, with OIDC preferred over static
tokens.

## Release Pipeline

There is no release pipeline for this repo. It does not publish an npm package,
CLI binary, Homebrew formula, marketplace action, or app artifact.

If this repo ever starts publishing a versioned artifact, add a release
pipeline with this shape:

1. verify on pull requests and pushes
2. release only on pushes to `main`
3. use Conventional Commits for release analysis
4. publish through a protected `release` Environment
5. commit the version bump back to `main` with `[skip ci]`

Release credentials belong in the `release` Environment, not in repo-level
secrets unless they are bootstrap-only.

## Maintenance

Dependabot tracks GitHub Actions updates through `.github/dependabot.yml`.
When Actions or scanner versions change, verify both workflows on GitHub before
calling the change done.
