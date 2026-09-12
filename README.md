![dotfiles — macOS and Linux bootstrap for workstations and remote coding users.](https://uinaf.dev/og/banner/dotfiles.png)

# uinaf/dotfiles

macOS and Ubuntu setup for one Unix user: packages, shell and Git defaults,
runtimes, coding agents, and maintenance. Private identities and secrets stay
outside Git.

## Start

- New machine: follow [Bootstrap](docs/bootstrap.md).
- Choose a [profile](docs/profiles.md); `developer` is the default when none
  is given.
- On a configured machine, preview changes before applying them:

```zsh
cd ~/projects/dotfiles
./dotfiles diff
./dotfiles apply
./dotfiles check
```

Homebrew packages, identities, and host settings have separate bootstrap steps.

## Guides

| Task | Guide |
| --- | --- |
| Choose packages and a user role | [Profiles](docs/profiles.md) |
| Set up age, Git, SSH, and recovery | [Identities](docs/identities.md) |
| Configure shared-host services | [Devbox](docs/devbox.md) |
| Update software or clean old worktrees | [Maintenance](docs/software-updates.md) |
| Configure coding agents | [Agents](docs/agents.md) |
| Edit managed files | [Chezmoi](docs/chezmoi.md) |
| Change runtime pins or find tasks | [Mise](docs/mise.md) |
| Audit a repository or Mac | [Security audits](docs/security-audits.md) |
| Install mobile and TV tooling | [Mobile and TV development](docs/mobile-and-tv-development.md) |
| Change this repository | [Contributing](CONTRIBUTING.md) |

[Security reporting](SECURITY.md) · [MIT license](LICENSE)
