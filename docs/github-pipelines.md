# GitHub Pipelines

GitHub Actions verifies repository changes, scans Git history for secrets, and
creates tag-only GitHub Releases.

## Workflows

| Workflow | Trigger | Contract |
| --- | --- | --- |
| Verify | Pull request, manual dispatch | Run every deterministic domain in parallel through `./scripts/verify/run.ts --skip-security` on macOS. Pushes to `main` skip this job and run only release evaluation. |
| Scan | Pull request, weekly schedule, manual dispatch | Call the shared `uinaf/.github` scan workflow: Gitleaks, TruffleHog, Actionlint, and Zizmor against full Git history. |

CI does not use path filters. Neither workflow runs on push: pull requests
verify and scan the same tree before merge, and the weekly schedule covers
history, so do not restore the push triggers. The full local equivalent is:

```zsh
./scripts/verify/run.ts
```

## Releases

Git tags and GitHub Releases are the version boundary. Inspect a checkout with:

```zsh
git describe --tags --always --dirty
```

Pushes to `main` release without re-verifying: verification happens on the
pull request for the same tree, so the release job carries no `needs:` gate.
Direct pushes to `main` must run the local gate first, `mise run verify:fast`
at minimum. On each push, semantic-release evaluates Conventional Commits
since the latest `v*` tag:

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
