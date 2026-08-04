# Agent Readiness

This repository separates deterministic repository proof from checks that need
a real macOS user, home directory, or service runtime.

## Repository Proof

Run the full gate before committing:

```zsh
mise run verify
```

It checks shell syntax and ShellCheck, GitHub Actions, profile rendering,
agent-sync contracts, SOPS and Git configuration, vendor-neutral interfaces,
diff hygiene, agent entrypoints, and repository secret scans. Use
`mise run verify:fast` during local iteration; it omits Gitleaks and
TruffleHog.

Install the fast gate as a pre-push hook with:

```zsh
./scripts/bootstrap/install-git-hooks.sh
```

## Live Proof

Run live checks only as the Unix user that should satisfy the selected
profile.

| Surface | Command | Proves |
| --- | --- | --- |
| Workstation | `mise run verify:bootstrap:workstation` | Required package layers, age identity, mise tools, Codex ChatGPT login default, and managed config exist. |
| Devbox | `mise run verify:bootstrap:devbox` | Developer package layers, age identity, mise tools, Codex ChatGPT login default, and managed config exist. |
| Assistant | `mise run verify:bootstrap:assistant` | Minimal package layers, age identity, managed Git base, and workload authorship match the assistant contract. |
| Service | `mise run verify:bootstrap:service` | Identity-safe package layers, age identity, minimal Git base, and unsigned workload authorship match the service contract. |
| Devbox services | `mise run verify:devbox-services` | Launchd, age, and local service configuration match the shared-host contract. |
| Workstation drift | `mise run audit:workstation` | Human Git, SSH, Codex, secret, permission, and local-state boundaries are visible. |
| Devbox drift | `mise run audit:devbox` | Agent-user identity, service, secret, project-permission, and Tailscale boundaries are visible. |
| Host hardening | `mise run audit:host` | Lynis reports the current host hardening index, warnings, and suggestions. |

Live audits support `:json` task variants for compact collection. Treat raw
prose output as sensitive because maintained scanners may include matched
material.

## Agent Workflow

For a repository change:

1. Read [Agent guide](../AGENTS.md) and the guide that owns the affected
   contract.
2. Preserve unrelated worktree changes.
3. Make the smallest scoped change.
4. Run focused proof and `mise run verify`.
5. Commit only the verified diff.

For live setup, confirm the target profile, follow
[Bootstrap](bootstrap.md), then run its live profile check. Devbox users also
run the service check and devbox audit.

## CI

GitHub Actions runs repository checks on macOS and secret scanning with full
Git history. Host-local identities and services remain live-machine checks.
See [GitHub pipelines](github-pipelines.md) for triggers and release behavior.
