# GitHub Pipelines

GitHub Actions verifies repository changes, scans Git history for secrets, and
creates tag-only GitHub Releases.

## Workflows

| Workflow | Trigger | Contract |
| --- | --- | --- |
| Verify | Push to `main`, pull request, manual dispatch | Run every deterministic domain in parallel through `./scripts/verify/repo.sh --skip-security` on macOS. Successful pushes to `main` continue to release evaluation. |
| Secret scanning | Push to `main`, pull request, weekly schedule, manual dispatch | Run Gitleaks and TruffleHog with full Git history. |

CI does not use path filters. The secret workflow stays separate and fails
closed against full Git history. The full local equivalent is:

```zsh
./scripts/verify/repo.sh
```

## Releases

Git tags and GitHub Releases are the version boundary. Inspect a checkout with:

```zsh
git describe --tags --always --dirty
```

After repository verification succeeds on a push to `main`, semantic-release
evaluates Conventional Commits since the latest `v*` tag:

| Commit | Release |
| --- | --- |
| `feat` | Minor |
| `fix`, `chore`, `build`, `refactor`, `perf`, `revert` | Patch |
| Breaking-change marker | Major |
| `docs`, `test`, `ci` | None |

The release job creates a tag, generated notes, and a GitHub Release through
the workflow-scoped `GITHUB_TOKEN`. Release concurrency is non-cancellable so
a later push cannot interrupt an in-progress release.

## Maintenance

- Dependabot tracks GitHub Actions monthly.
- Keep Actions and semantic-release plugins pinned.
- Keep `.releaserc.json` aligned with the table above.
- Verify workflow changes on GitHub before closing them.
