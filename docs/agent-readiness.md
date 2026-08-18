# Agent Readiness

This repository separates deterministic repository proof from checks that need
a real macOS user, home directory, or service runtime.

## Repository Proof

List the verification domains and run the one that owns the change:

```zsh
mise run verify:domain config # example; select the owning domain
mise run verify:fast
mise run verify
```

- Each domain declares its inputs and proof in the
  [verification registry](../scripts/verify/checks.json).
- Checks marked `complete only` cover cross-domain parity and stay out of focused
  domain runs.
- `mise run verify:fast` runs every deterministic check in parallel.
- `mise run verify` also runs Gitleaks and TruffleHog against full history.
- CI always runs the complete deterministic graph.

Install the focused commit-hygiene hook with:

```zsh
./scripts/verify/install-pre-push-hook.sh
```

- The hook reads the ref updates supplied by Git and checks only outgoing commit
  objects for whitespace and conflict-marker errors.
- It leaves the working tree and repository domains alone.
- Like every local hook, it can be bypassed with `git push --no-verify`. CI is
  the enforcement boundary.

## Live Proof

Run live checks only as the Unix user that should satisfy the selected
profile.

| Surface | Command | Proves |
| --- | --- | --- |
| Workstation | `mise run verify:bootstrap workstation` | Required package layers, SOPS/age CLIs, mise tools, Codex CLI, and managed config exist. Age identity is optional until secrets are consumed. |
| Personal workstation | `mise run verify:bootstrap personal-workstation` | Workstation package and runtime contracts exist with personal packages, dotfiles, and skills selected. |
| Personal devbox | `mise run verify:bootstrap personal-devbox` | Devbox package, identity, and runtime contracts exist with headless personal tools, dotfiles, and skills selected. |
| Devbox | `mise run verify:bootstrap devbox` | Developer package layers, age identity, mise tools, Codex CLI, and managed config exist. |
| Assistant | `mise run verify:bootstrap assistant` | Shared browser and GitHub tools, assistant automation packages, age identity, managed Git base, and workload authorship match the assistant contract. |
| Devbox services | `mise run verify:devbox-services` | Launchd, age, and local service configuration match the shared-host contract. |
| Workstation drift | `mise run audit workstation` | Human Git, SSH, Codex, secret, permission, and local-state boundaries are visible. |
| Devbox drift | `mise run audit devbox` | Agent-user identity, service, secret, project-permission, and Tailscale boundaries are visible. |
| Host hardening | `mise run audit host` | Lynis reports the current host hardening index, warnings, and suggestions. |

Live audits support `--format json` for compact collection. Treat raw
prose output as sensitive because maintained scanners may include matched
material.

## Agent Workflow

For a repository change:

1. Read [Agent guide](../AGENTS.md) and the guide that owns the affected
   contract.
2. Preserve unrelated worktree changes.
3. Make the smallest scoped change.
4. Run the focused verification domain for the changed contract.
5. Commit only the verified diff.

For live setup, confirm the target profile, follow
[Bootstrap](bootstrap.md), then run its live profile check. Devbox and
personal-devbox users also
run the devbox audit.

## CI

GitHub Actions runs repository checks on macOS and secret scanning with full
Git history. Host-local identities and services remain live-machine checks.
See [GitHub pipelines](github-pipelines.md) for triggers and release behavior.
