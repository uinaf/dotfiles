# uinaf/dotfiles

A vendor-neutral macOS bootstrap framework for workstations, remote coding
users, unattended assistants, and managed service identities.

The repository manages Homebrew layers, chezmoi source state, mise runtimes,
Git and SSH defaults, coding-agent setup, and verification scripts. Installed
paths and interfaces use generic `dotfiles` names; private identities and
secret values remain local or in an approved recovery system.

## Choose a Profile

Profiles apply to one Unix user. Host-wide Homebrew, power, Spotlight,
Tailscale, and LaunchDaemon state still requires an authorized administrator.

| Profile | Use it for | Software layers |
| --- | --- | --- |
| `workstation` | Interactive human development on a laptop or desktop | Base + developer + workstation |
| `personal-workstation` | Owner-operated Mac with the workstation shape plus personal apps, tools, skills, and preferences | Base + developer + workstation + personal |
| `personal-devbox` | Owner-operated remote Mac with the devbox shape plus headless personal tools and skills | Base + developer + devbox + personal |
| `devbox` | Remote coding on an SSH-first host | Base + developer + devbox |
| `assistant` | Unattended persona or agent workload | Base + assistant |
| `service` | Non-persona managed platform workload | Base + service |

Read [User profiles](docs/profiles.md) before configuring multiple users on one
Mac. Existing installations that still use the former owner-specific layout
should follow [Migrating to role profiles](docs/migrating-to-role-profiles.md)
before applying a profile.

## Install

Install Apple Command Line Tools and Homebrew, then bootstrap a workstation:

```zsh
brew install git gh
gh auth login
mkdir -p ~/projects
gh repo clone uinaf/dotfiles ~/projects/dotfiles
cd ~/projects/dotfiles

./scripts/bootstrap/brew-bundle.sh workstation
mise trust
./dotfiles diff workstation
./dotfiles apply workstation
# Optional until this machine decrypts vault or other SOPS material:
# ./scripts/secrets/configure-sops-age-identity.sh
./scripts/bootstrap/configure-git.sh --profile workstation
./scripts/bootstrap/configure-power.sh --profile workstation
./scripts/bootstrap/configure-spotlight.sh
./dotfiles check workstation
```

When you do provision an age identity for live ciphertext, register and verify
its recovery copy as described in [Identity
provisioning](docs/identities.md#back-up-and-verify-recovery).

Use the [Bootstrap guide](docs/bootstrap.md) for first-machine prerequisites,
devbox, assistant, and service flows, optional desktop setup, updates, and
troubleshooting.

## Managed Surfaces

| Surface | Source of truth |
| --- | --- |
| Packages | `Brewfile`, `Brewfile.developer`, and `Brewfile.<profile>` |
| Per-user convergence | `./dotfiles`, backed by `chezmoi/`, mise, and profile install steps |
| Runtimes and CLIs | `chezmoi/private_dot_config/mise/config.toml.tmpl` |
| Git, SSH, age, and GitHub App setup | `scripts/bootstrap/`, `scripts/secrets/`, and [Identity provisioning](docs/identities.md) |
| Global coding-agent rules | `chezmoi/`, with optional private text from local chezmoi data |
| Global coding-agent skills | `scripts/agents/`, with personal additions selected by profile |
| Repository and host checks | `scripts/verify/` and `scripts/audit/` |

Consumer repositories own project dependencies, encrypted payloads, runtime
services, and repository-local agent instructions. The optional
[SOPS vault template](https://github.com/uinaf/sops-vault-template) provides a
standalone starting point for encrypted capability-scoped repositories.

## Verify

List the verification domains and run the one that owns the change:

```zsh
mise run verify:domain config # example; select the owning domain
mise run verify:fast
mise run verify
```

The fast task runs the deterministic graph. The complete task also scans full
Git history. CI always runs the deterministic graph. Live profile and host checks are documented in
[Agent readiness](docs/agent-readiness.md) and
[Security audits](docs/security-audits.md).

## Documentation

| Need | Guide |
| --- | --- |
| Install or update a Mac | [Bootstrap](docs/bootstrap.md) |
| Choose a per-user role | [User profiles](docs/profiles.md) |
| Provision age, Git, SSH, or GitHub identity | [Identity provisioning](docs/identities.md) |
| Run services on a shared host | [Devbox setup](docs/devbox.md) |
| Apply global coding-agent rules or sync skills | [Agent setup](docs/agents.md) |
| Edit chezmoi source state | [Chezmoi](docs/chezmoi.md) |
| Use repo tasks or change runtime pins | [Mise](docs/mise.md) |
| Understand local and CI proof | [Agent readiness](docs/agent-readiness.md) |
| Understand Actions and releases | [GitHub pipelines](docs/github-pipelines.md) |
| Run security checks | [Security audits](docs/security-audits.md) |
| Build React Native apps | [React Native](docs/react-native.md) |
| Find script entrypoints | [Scripts](scripts/README.md) |

## Contributing

See [Contributing](CONTRIBUTING.md) for setup and verification expectations.
Report vulnerabilities through the private path in [Security](SECURITY.md).

## License

MIT. See [License](LICENSE).
