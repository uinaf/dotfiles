# GitHub Pipelines

GitHub Actions verifies repository changes, scans Git history for secrets, and
creates tag-only GitHub Releases.

## Workflows

| Workflow | Trigger | Contract |
| --- | --- | --- |
| Verify | Push to `main`, pull request, manual dispatch | Run every deterministic domain with bounded concurrency through `./scripts/verify/run.ts --skip-security` on macOS. Pushes to `main` skip this job and run only release evaluation. |
| Scan | Pull request, weekly schedule, manual dispatch | Call the shared `uinaf/.github` scan workflow: Gitleaks, TruffleHog, Actionlint, and Zizmor against full Git history. |

This public repository uses standard GitHub-hosted runners: `macos-26` for
native macOS repository checks and `ubuntu-24.04-arm` for release evaluation.
Both jobs retain ARM64 execution. The verification runner admits at most four
checks at once, reserving one logical CPU where available because checks spawn
their own workers.

CI does not use path filters. Repository checks and secret scans do not run
on push: pull requests verify and scan before merge, and the weekly schedule
scans history. Direct pushes require `mise run verify` locally before pushing.
Keep this trigger split to avoid duplicate macOS runs. The full local gate is:

```zsh
mise run verify
```

## Releases

Git tags and GitHub Releases are the version boundary. Inspect a checkout with:

```zsh
git describe --tags --always --dirty
```

Pushes to `main` release without re-verifying, so the release job carries no
`needs:` gate. A successful GitHub Release job proves only release evaluation
and any resulting publication; it does not prove repository checks or secret
scans passed. On each push, semantic-release evaluates Conventional Commits
since the latest `v*` tag:

| Commit | Release |
| --- | --- |
| `feat` | Minor |
| `fix`, `chore`, `build`, `refactor`, `perf`, `revert` | Patch |
| Breaking-change marker | Major |
| `docs`, `test`, `ci` | None |

The release job creates a tag, generated notes, and a GitHub Release using a
short-lived GitHub App installation token scoped to this repository with
Contents write access. The `release` environment supplies the App credentials.
Release concurrency is non-cancellable so a later push cannot interrupt an
in-progress release.

## Maintenance

- Renovate tracks Actions, repository dependencies, runtime tools, skills CLI,
  and runtime package pins daily (00:00–06:00 Europe/Istanbul), with a seven-day
  release age through the shared `uinaf/renovate-config` preset.
- GitHub auto-merges eligible Renovate PRs with squash after the required
  `Repository checks`, `scan / Gitleaks`, `scan / TruffleHog`,
  `scan / Actionlint`, and `scan / Zizmor` checks pass. The repository opts into
  `platformAutomerge` so merges do not wait for another hosted Renovate run.
  Add new voting checks to the required-check ruleset when introducing them.
- The required-check ruleset targets the default branch and accepts checks
  from GitHub Actions. It does not require an up-to-date branch. Repository
  admins retain verified direct pushes through a bypass scoped to this
  ruleset; Renovate has no bypass. The existing signature, deletion, and
  force-push rules remain separate.
- The shared preset's strict release-age filter prevents young updates from
  entering PRs. Majors and digest-only updates stay manual. Node, pnpm, and
  PyYAML pins are grouped across their consumers; the runtime pin check
  rejects partial updates. Frozen-lockfile installation gates artifact updates.
- Keep third-party Actions and semantic-release plugins hash/version pinned.
  The first-party shared scanner tracks `main` for centrally maintained updates;
  `.github/zizmor.yml` enforces this exception.
- Keep `.releaserc.json` aligned with the table above.
- Verify workflow changes on GitHub before closing them.
