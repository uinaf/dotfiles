# Scripts

Run scripts from the repository root. `mise.toml` provides the small public
task graph; reusable behavior stays here.

| Directory | Purpose |
| --- | --- |
| `agents/` | Install additive global skill selections and opt-in coding-client helpers. |
| `app-store/` | Manage workstation Mac App Store applications through `mas`. |
| `audit/` | Run non-destructive repository, host, workstation, and devbox audits. |
| `bootstrap/` | Install packages and configure dotfiles, Git, coding tools, and host policy. |
| `lib/` | Shared Effect services and typed automation contracts. |
| `maintenance/` | Collect freshness-aware read-only maintenance snapshots. |
| `profiles/` | Strict TypeScript parsing and tests for the canonical profile model. |
| `secrets/` | Provision SOPS age identities and expose narrow sudo boundaries. |
| `tizen/` | Install Tizen Studio and manage local certificate/profile archives. |
| `verify/` | Check repository contracts and live profile/service state. |

## Repository Checks

Use the verification tasks in [Mise](../docs/mise.md#tasks); `mise run audit
repo --format json` covers the repository secret scan.

## Bootstrap

`./dotfiles` is the operator entrypoint, and [Bootstrap](../docs/bootstrap.md)
owns the canonical per-profile command sequences. The scripts below the
entrypoint remain narrow implementation owners and are also used by repository
tests.

| Need | Guide |
| --- | --- |
| Required order | [Bootstrap](../docs/bootstrap.md) |
| Git and credential setup | [Identity provisioning](../docs/identities.md) |
| Role boundaries | [User profiles](../docs/profiles.md) |

Headless macOS coding services use
`scripts/bootstrap/install-devbox-service-daemons.ts`; see
[Devbox setup](../docs/devbox.md#system-services).
Use `scripts/bootstrap/sync-devbox-t3-server.ts` on a workstation to converge
one explicit remote T3 Code server to the workstation's installed version. The
command streams the installer sources and uses the remote user's home as the
server working directory.

Use `scripts/verify/t3-server-version.ts --host USER@HOST` first for a
strictly read-only comparison. It emits typed JSON for the workstation app,
remote installed version, version match, launchd state, and HTTP health.

## Effect Runtime

Repository automation uses `effect` and `@effect/platform-node` at the version
pinned in `package.json`. Install the locked graph with
`pnpm install --frozen-lockfile`; run `pnpm typecheck` before the repository
verification graph.

Shell remains only at protocol boundaries that cannot assume this
repository's Node module graph:

| Boundary | Reason |
| --- | --- |
| `agents/llm-gateway-credential.sh` | Copied as a standalone credential helper for external clients. |
| `agents/cursor-agent-api.sh` | Copied to dotfiles libexec as Cursor's stable API-key adapter. |
| `agents/codex-gatewai.sh` | Copied to dotfiles libexec; launches Codex with gateway overrides for harnesses that pass `--ignore-user-config`. |
| `lib/sudo-age-askpass.sh` | Invoked directly by macOS `sudo` through `SUDO_ASKPASS`, including from an isolated temporary directory. |
| `../dotfiles` | Operator entrypoint that provisions the Node module graph before delegating to `scripts/dotfiles.ts`. |

Parsing, policy, retries, filesystem mutation, and command orchestration stay
in Effect TypeScript. These shell files only translate their fixed process
protocol.

## Global Agent Setup

```zsh
./dotfiles diff workstation
./dotfiles apply workstation
mise run agents:sync
mise run agents:update
```

- Chezmoi owns global rules and links.
- `./scripts/agents/sync.ts` is the direct skill entrypoint.
- `./scripts/agents/plugins.ts` applies plugin marketplaces.
- See [Agent setup](../docs/agents.md) for the optional private rule layer, the
  plugin manifests, and `--update` global skill and plugin refresh.

## Live Audits

```zsh
mise run audit host --format json
mise run audit workstation --format json
mise run audit devbox --format json
./scripts/verify/devbox-services.ts
```

See [Security audits](../docs/security-audits.md) before collecting or sharing
output from a live machine.
