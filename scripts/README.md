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
./scripts/verify/repo.sh --list
./scripts/verify/repo.sh --domain config # example; select the owning domain
./scripts/verify/repo.sh --skip-security
./scripts/verify/repo.sh
./scripts/audit/repo.sh --skip-mscp --json
```

## Bootstrap

```zsh
profile=workstation
./scripts/bootstrap/brew-bundle.sh "$profile"
./scripts/bootstrap/apply-dotfiles.sh --profile "$profile"
mise trust
mise install
./scripts/bootstrap/install.sh --profile "$profile"
./scripts/secrets/configure-sops-age-identity.sh
./scripts/bootstrap/configure-git.sh --profile "$profile"
./scripts/verify/bootstrap.sh --profile "$profile"
```

Use [Bootstrap](../docs/bootstrap.md) for the required order,
[Identity provisioning](../docs/identities.md) for Git and credential setup,
and [User profiles](../docs/profiles.md) for role boundaries.

## Global Agent Setup

```zsh
mise run dotfiles:diff workstation
mise run dotfiles:apply workstation
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
