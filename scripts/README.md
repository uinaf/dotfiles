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
| `profiles/` | Strict TypeScript parsing and tests for the canonical profile model. |
| `secrets/` | Provision SOPS age identities and expose narrow sudo boundaries. |
| `tizen/` | Install Tizen Studio and manage local certificate/profile archives. |
| `verify/` | Check repository contracts and live profile/service state. |

## Repository Checks

```zsh
mise run verify:domain config # example; select the owning domain
mise run verify:fast
mise run verify
mise run audit repo --format json
```

## Bootstrap

```zsh
profile=workstation
./scripts/bootstrap/brew-bundle.ts "$profile"
mise trust
./dotfiles diff "$profile"
./dotfiles apply "$profile"
./scripts/secrets/configure-sops-age-identity.ts
./scripts/bootstrap/configure-git.ts --profile "$profile"
./dotfiles check "$profile"
```

`./dotfiles` is the operator entrypoint. The scripts below it remain narrow
implementation owners and are also used by repository tests.

| Need | Guide |
| --- | --- |
| Required order | [Bootstrap](../docs/bootstrap.md) |
| Git and credential setup | [Identity provisioning](../docs/identities.md) |
| Role boundaries | [User profiles](../docs/profiles.md) |

Headless macOS coding services use
`scripts/bootstrap/install-devbox-service-daemons.ts`; see
[Devbox setup](../docs/devbox.md#system-services).
Use `scripts/bootstrap/sync-devbox-t3-server.ts` on a workstation to converge
one explicit remote T3 Code server to the workstation's nightly version. The
command streams the installer sources and uses the remote user's home as the
server working directory.

## Effect Runtime

Repository automation uses Effect `4.0.0-rc.112` and
`@effect/platform-node` on the same RC. Install the locked graph with
`pnpm install --frozen-lockfile`; run `pnpm typecheck` before the repository
verification graph.

Shell remains only at three protocol boundaries that cannot assume this
repository's Node module graph:

| Boundary | Reason |
| --- | --- |
| `agents/llm-gateway-credential.sh` | Copied as a standalone credential helper for external clients. |
| `agents/cursor-agent-api.sh` | Copied as the stable executable adapter expected by Cursor. |
| `lib/sudo-age-askpass.sh` | Invoked directly by macOS `sudo` through `SUDO_ASKPASS`, including from an isolated temporary directory. |

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
