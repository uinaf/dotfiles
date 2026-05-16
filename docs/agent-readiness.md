# Agent Readiness

This repo is a bootstrap repo, not an app. There is no server to boot and no UI
flow to drive. Agent readiness means an agent can:

1. understand which machine profile it is working on
2. make a scoped repo change safely
3. verify repository health mechanically
4. verify live host drift only when it is operating on that host
5. avoid copying private machine state into Git

## Current Grade

| Dimension | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Bootable | pass | `scripts/bootstrap/brew-bundle.sh` installs shared plus profile bundles; `scripts/bootstrap/install.sh` applies the repo-local chezmoi source state and Codex defaults. | First-time macOS still needs Command Line Tools, Homebrew, and GitHub auth. |
| Testable | pass | `scripts/verify/repo.sh` runs shell syntax, ShellCheck, Actionlint, diff hygiene, agent-entrypoint checks, and repo secret scans. | Live bootstrap checks require a matching personal or devbox Mac. |
| Observable | pass | Verification and audit scripts print stable sectioned output; security audits also support compact `--json` summaries; CI exposes Verify and Secret scanning logs. | SARIF output is not generated yet. |
| Verifiable | pass | `.github/workflows/verify.yml`, `.github/workflows/secrets.yml`, `scripts/verify/bootstrap.sh`, `scripts/verify/devbox-services.sh`, and audit scripts. | Host-local service and token checks cannot run meaningfully on GitHub-hosted CI. |

Overall grade: **B for a bootstrap repo**.

The repo has a reliable repo gate, CI gates, and separate host-local audits.
The remaining readiness gap is richer machine-readable report formats such as
SARIF for tools that can emit it cleanly.

## Verification Matrix

| Situation | Command | What it proves |
| --- | --- | --- |
| Before committing repo changes | `mise run verify` | Scripts and mise task files parse, ShellCheck passes, workflows lint, diffs are clean, agent entrypoints are valid, and secret scanners pass. |
| Fast local loop | `mise run verify:fast` | Same repo checks without Gitleaks/TruffleHog. Run the full command before commit. |
| Install local push guard | `./scripts/bootstrap/install-git-hooks.sh` | Adds a pre-push hook that runs `scripts/verify/repo.sh --skip-security` before pushing. |
| Personal Mac bootstrap | `mise run verify:bootstrap:personal` | Required CLIs, Homebrew bundle, mise, Codex defaults, and installed config exist on the live host. |
| Devbox bootstrap | `mise run verify:bootstrap:devbox` | Shared/devbox CLIs, Homebrew bundle, mise, Codex defaults, and installed config exist on the live host. |
| Devbox service boundary | `mise run verify:devbox-services` | process-compose and generated env/token boundaries match the local devbox contract. |
| Devbox security drift | `mise run audit:devbox` | Secret boundaries, Git/GitHub identity, SSH key modes, admin drift, and Tailscale health are sane for that Unix user. |
| Personal security drift | `mise run audit:personal` | Personal shell, Git, SSH, Codex, and local secret boundaries do not show obvious drift. |
| Host hardening audit | `mise run audit:host` | Lynis runs as a maintained broad host scanner and reports hardening index, warnings, and suggestions. |
| Repository audit | `mise run audit:repo` | Gitleaks/TruffleHog pass without the optional mSCP host audit. |
| Repository and macOS audit | `mise run audit:mscp` | Gitleaks/TruffleHog pass; optional mSCP check-only audit runs when configured. |

## Agent Workflow

For docs or script changes:

1. Read [Agent guide](../AGENTS.md) and the specific doc for the surface being
   changed.
2. Run `git status --short --branch`.
3. Make the smallest scoped change.
4. Run `mise run verify`.
5. Commit only the scoped diff.

For live machine setup:

1. Confirm whether the target is `personal` or `devbox`.
2. Follow [Bootstrap guide](bootstrap.md).
3. Run the matching live verification command.
4. For devbox users, also run `./scripts/verify/devbox-services.sh` and
   `./scripts/audit/devbox.sh`.
5. Do not copy private values from the live machine into the repo.

## CI Contract

GitHub Actions has two separate gates:

- Verify: repo checks that do not need secrets.
- Secret scanning: Gitleaks and TruffleHog with full Git history.

See [GitHub pipelines](github-pipelines.md) for triggers and non-goals.

## Non-Goals

- No app boot command, seed data, browser e2e, or service health endpoint.
- No automatic Lynis or mSCP remediation.
- No tracked Codex state, browser profiles, service-account tokens, or generated
  devbox env files.
- No deploy or release pipeline unless the repo starts publishing an artifact.

## Future Improvements

- Add optional SARIF output for scanners that support it cleanly.
- Add a lightweight report collector for comparing both devbox users in one run.
