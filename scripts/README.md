# Scripts

Run scripts from the repository root. `mise.toml` provides the small public
task graph; reusable behavior stays here.

| Directory | Purpose |
| --- | --- |
| `agents/` | Install additive global skill selections. |
| `app-store/` | Manage workstation Mac App Store applications through `mas`. |
| `audit/` | Run non-destructive repository, host, workstation, and devbox audits. |
| `bootstrap/` | Install packages and configure dotfiles, Git, coding tools, and host policy. |
| `lib/` | Shared shell helpers. |
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
./scripts/bootstrap/brew-bundle.sh "$profile"
mise trust
./dotfiles diff "$profile"
./dotfiles apply "$profile"
./scripts/secrets/configure-sops-age-identity.sh
./scripts/bootstrap/configure-git.sh --profile "$profile"
./dotfiles check "$profile"
```

`./dotfiles` is the operator entrypoint. The scripts below it remain narrow
implementation owners and are also used by repository tests.

Use [Bootstrap](../docs/bootstrap.md) for the required order,
[Identity provisioning](../docs/identities.md) for Git and credential setup,
and [User profiles](../docs/profiles.md) for role boundaries.

## Global Agent Setup

```zsh
./dotfiles diff workstation
./dotfiles apply workstation
mise run agents:sync
mise run agents:update
```

Chezmoi owns global rules and links. The direct skill entrypoint is
`./scripts/agents/sync.ts`. See [Agent setup](../docs/agents.md) for the optional
private rule layer and `--update` global skill refresh.

## Live Audits

```zsh
./scripts/audit/host.sh --json
./scripts/audit/workstation.sh --json
./scripts/audit/devbox.sh --json
./scripts/verify/devbox-services.sh
```

See [Security audits](../docs/security-audits.md) before collecting or sharing
output from a live machine.
