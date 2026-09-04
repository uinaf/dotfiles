![dotfiles — vendor-neutral macOS bootstrap for every role.](https://uinaf.dev/og/banner/dotfiles.png)

# uinaf/dotfiles

A vendor-neutral macOS bootstrap framework for workstations, remote coding
users.

The repository manages Homebrew layers, chezmoi source state, mise runtimes,
Git and SSH defaults, coding-agent setup, and verification scripts. Installed
paths and interfaces use generic `dotfiles` names; private identities and
secret values remain local or in an approved recovery system.

## Choose a Profile

- Profiles apply to one Unix user.
- Host-wide Homebrew, power, Spotlight, Tailscale, and LaunchDaemon state still
  requires an authorized administrator.
- Choose the profile and software layers in [User profiles](docs/profiles.md)
  before configuring one or more users on a Mac.

## Install

Install Apple Command Line Tools and Homebrew, then clone the repository:

```zsh
brew install git gh
gh auth login
mkdir -p ~/projects
gh repo clone uinaf/dotfiles ~/projects/dotfiles
cd ~/projects/dotfiles
```

Then follow the [Bootstrap guide](docs/bootstrap.md). It owns the canonical
per-profile command sequences plus first-machine prerequisites, devbox and
optional desktop setup, updates, and troubleshooting.

## Managed Surfaces

| Surface | Source of truth |
| --- | --- |
| Packages | `Brewfile`, `Brewfile.developer`, and `Brewfile.<profile>` |
| Per-user convergence | `./dotfiles`, backed by `chezmoi/`, mise, and profile install steps |
| Runtimes and CLIs | `chezmoi/private_dot_config/mise/config.toml.tmpl` |
| Git, SSH, age, and GitHub App setup | `scripts/bootstrap/`, `scripts/secrets/`, and [Identity provisioning](docs/identities.md) |
| Global coding-agent rules | `chezmoi/`, with optional private start and end fragments under `~/.config/dotfiles/` |
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

- `verify:fast` runs the deterministic graph.
- `verify` also scans full Git history.
- CI always runs the deterministic graph.
- Live profile and host checks live in [Mise](docs/mise.md#task-namespaces)
  and [Security audits](docs/security-audits.md).

## Documentation

| Need | Guide |
| --- | --- |
| Install or update a Mac | [Bootstrap](docs/bootstrap.md) |
| Choose a per-user role | [User profiles](docs/profiles.md) |
| Provision age, Git, SSH, or GitHub identity | [Identity provisioning](docs/identities.md) |
| Configure a devbox, coding LLM gateway, or shared-host service | [Devbox setup](docs/devbox.md) |
| Apply global coding-agent rules or sync skills | [Agent setup](docs/agents.md) |
| Edit chezmoi source state | [Chezmoi](docs/chezmoi.md) |
| Use repo tasks, run local proof, or change runtime pins | [Mise](docs/mise.md) |
| Understand Actions and releases | [GitHub pipelines](docs/github-pipelines.md) |
| Run security checks | [Security audits](docs/security-audits.md) |
| Build mobile and TV apps | [Mobile and TV development](docs/mobile-and-tv-development.md) |
| Find script entrypoints | [Scripts](scripts/README.md) |

## Contributing

See [Contributing](CONTRIBUTING.md) for setup and verification expectations.
Report vulnerabilities through the private path in [Security](SECURITY.md).

## License

MIT. See [License](LICENSE).
