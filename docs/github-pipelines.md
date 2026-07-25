# GitHub Pipelines

This repo uses GitHub Actions for repository verification, secret scanning, and
tag-only GitHub Releases. It does not deploy a running service or publish to a
package registry.

## Current Workflows

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| Verify | push to `main`, pull request, manual dispatch | Run repository checks that do not need secrets. After a successful push to `main`, create a semantic GitHub Release when the commits require one. |
| Secret scanning | push to `main`, pull request, weekly schedule, manual dispatch | Run Gitleaks and TruffleHog with full Git history available. |

The local canonical command remains:

```zsh
./scripts/verify/repo.sh
```

The Verify workflow runs `./scripts/verify/repo.sh --skip-security`
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

Git tags and GitHub Releases are the canonical version boundary. There is no
package manifest, package-manager version, checked-in `VERSION` file, changelog
commit, registry publish, or release asset build. Use this command to inspect a
checkout:

```zsh
git describe --tags --always --dirty
```

`v1.0.0` is the established bootstrap baseline. Future pushes to `main` run the
repository verifier first, then semantic-release reads Conventional Commits
since the latest `v*` tag:

- `feat` creates a minor release.
- `fix`, `chore`, `build`, `refactor`, `perf`, and `revert` create a patch
  release.
- a breaking-change marker creates a major release.
- `docs`, `test`, and `ci` do not release.

The release job creates only the tag, generated release notes, and GitHub
Release through the workflow-scoped `GITHUB_TOKEN`. It does not push a version
commit to `main`, so it remains compatible with the repository's restricted
default-branch writers. No release Environment or additional secret is needed.
Release concurrency is non-cancellable so a later push cannot interrupt tag and
GitHub Release creation.

## Maintenance

Dependabot tracks GitHub Actions updates through `.github/dependabot.yml`.
Keep every semantic-release plugin pinned in the workflow and keep
`.releaserc.json` aligned with the Conventional Commit policy above. When
Actions, release plugins, or scanner versions change, verify both workflows on
GitHub before calling the change done.
