# dotfiles

Reusable macOS bootstrap files for workstations, devboxes, and assistants.

This repo owns the portable layer: Homebrew bundles, chezmoi-managed zsh
startup, mise runtimes, Git and SSH defaults, Codex defaults, editor settings,
and setup and audit scripts.

It is standalone. It does not require an agent framework, workspace manager,
or any other companion repository.

Installed paths, commands, and configuration keys use generic `dotfiles`
names. Repository, tap, contact, and identifiers documented only in the manual
breaking-change guide retain their real external coordinates.

It does not own secret values, private identity material, Codex auth/state,
browser profiles, app caches, dependency folders, build output, or project
checkouts. Those stay machine-local or in their approved recovery system. It
does own portable identity provisioning and verification mechanics.

## Choose a Profile

| Layer or profile | Use it for | Installs |
| --- | --- | --- |
| Base | Minimal tools every managed Unix user needs. | `Brewfile` |
| Workstation | A human-operated laptop or desktop. | Base + `Brewfile.developer` + `Brewfile.workstation` |
| Devbox | A remote coding identity on an SSH-first host. | Base + `Brewfile.developer` + `Brewfile.devbox` |
| Assistant | An unattended assistant or platform-service identity. | Base + `Brewfile.assistant` |

Profiles apply per Unix user, while Homebrew and other macOS policy can be
host-wide. Read [User profiles](docs/profiles.md) before changing a shared host.
`personal` remains a temporary command alias for `workstation`.

## Fast Path

The role-profile release is breaking for existing users. Complete
[Migrating to Role Profiles](docs/migrating-to-role-profiles.md) before running
the new installer; no owner-specific configuration or service state is moved
automatically.

Install Apple Command Line Tools, Homebrew, `git`, and `gh`, then clone the
repo:

```zsh
gh auth login
mkdir -p ~/projects
gh repo clone uinaf/dotfiles ~/projects/dotfiles
cd ~/projects/dotfiles

./scripts/bootstrap/brew-bundle.sh workstation
./scripts/bootstrap/install.sh --profile workstation
./scripts/secrets/configure-sops-age-identity.sh
./scripts/bootstrap/configure-git.sh --profile workstation
./scripts/bootstrap/configure-power.sh --profile workstation
./scripts/bootstrap/configure-spotlight.sh
./scripts/app-store/personal.sh
mise trust
mise install
./scripts/verify/bootstrap.sh --profile workstation
```

If `git` or `gh` is not available yet, or for the full first-machine flow,
devbox setup, Chrome vertical tabs, Blacksmith, and Tizen notes, read
[Bootstrap guide](docs/bootstrap.md).

`configure-power.sh` and `configure-spotlight.sh` are deliberate sudo steps.
`install.sh` stays user-level and should not change system policy implicitly.

## What Gets Installed

`./scripts/bootstrap/install.sh` applies tracked files from `chezmoi/` into
`$HOME` through `scripts/bootstrap/apply-dotfiles.sh`. Use
[Bootstrap guide](docs/bootstrap.md) for the ordered setup flow,
[Chezmoi source state](docs/chezmoi.md) for source naming rules, and
[Mise tasks](docs/mise.md) for the split between repo tasks and machine runtime
pins.

| Surface | Tracked source | Local-only extension |
| --- | --- | --- |
| zsh | `chezmoi/dot_zshenv`, `chezmoi/dot_zprofile`, `chezmoi/dot_zshrc` | machine shell history and ad hoc local files |
| mise | `chezmoi/private_dot_config/mise/config.toml.tmpl` | repo-local runtime files; the selected profile controls machine runtime pins |
| Git | `chezmoi/dot_gitconfig.tmpl` | `~/.gitconfig.local`; assistants use workload authorship only |
| GitHub CLI | Developer and assistant layers install `gh`; developers receive `github/gh-stack`, while assistants receive a pinned `gh-app-auth` execution adapter | GitHub App credentials, token policy, and unrelated extensions |
| SOPS and age | Base layer plus explicit per-user identity provisioning | private identity backup, repository recipient policy, and encrypted payloads |
| SSH (workstation/devbox) | `chezmoi/private_dot_ssh/private_config` | `~/.ssh/github.config`, `~/.ssh/config.local`, private keys |
| Codex | installer-managed defaults, including ChatGPT-login enforcement | auth, sessions, approvals, memory, worktrees |
| Editors | developer Homebrew layer and chezmoi-managed Zed/Ghostty defaults | app state, fonts, caches |

Assistant users receive a minimal Git base and workload authorship, but no
signing, GitHub credential helper, outbound SSH, or developer desktop state.
The profile installs the `gh-app-auth` execution adapter, while GitHub App
credentials and repository authorization remain platform-owned setup.

## Local State Boundaries

Keep these out of Git:

- Git identity and signing keys.
- Infisical workspace/project auth and 1Password human vault references.
- SSH private keys, certificates, Tizen archives, and device keys.
- SOPS age private identities and decrypted secret files.
- Codex auth, Browser approvals, sessions, caches, worktrees, and app state.
- Browser profiles, Docker/Colima state, dependency folders, and build output.

For always-on agent hosts, use the secret model in
[Devbox setup](docs/devbox.md). The short version: humans may use 1Password and
Infisical, agents use Infisical machine identity auth only, and tokens or client
credentials must not live in default shells, process managers, tracked files, or
generated dotenv refresh stacks.

## Workstation Personalization

`Brewfile.workstation` is the shared human-operated Mac profile, not a private app
wishlist. Keep one-machine tweaks in local config files, keep durable personal
preferences in a fork, and send focused pull requests for changes that should
become part of the shared bootstrap.

## Verification

Use repo checks before committing:

```zsh
./scripts/verify/repo.sh
```

Equivalent mise task:

```zsh
mise trust
mise run verify
mise run verify:fast
```

To install the local pre-push guard for the fast repo gate:

```zsh
./scripts/bootstrap/install-git-hooks.sh
```

Use live-machine checks only on a machine that should actually use these
dotfiles:

```zsh
./scripts/verify/bootstrap.sh --profile workstation
./scripts/verify/bootstrap.sh --profile devbox
./scripts/verify/bootstrap.sh --profile assistant
./scripts/bootstrap/configure-desktop.sh
./scripts/verify/bootstrap.sh --profile devbox --desktop
```

The desktop commands are opt-in for the human owner profile on a devbox. They
set the built-in black system wallpaper, hide desktop icons and widgets, and
keep only Google Chrome in the persistent Dock. Do not apply that baseline to
the other devbox identities unless their desktop policy changes explicitly.

For security posture:

```zsh
./scripts/audit/repo.sh --skip-mscp
mise run audit:repo
./scripts/audit/host.sh
./scripts/audit/workstation.sh
./scripts/audit/devbox.sh
```

See [Security audits](docs/security-audits.md) for the audit layers, Lynis host
audit, and macOS Security Compliance Project flow.

## Docs Map

| Need | Read |
| --- | --- |
| Install or update a Mac | [Bootstrap guide](docs/bootstrap.md) |
| Choose a per-user role | [User profiles](docs/profiles.md) |
| Provision and recover an identity | [Identity provisioning](docs/identities.md) |
| Operate a shared agent host | [Devbox setup](docs/devbox.md) |
| Understand dotfile source state | [Chezmoi source state](docs/chezmoi.md) |
| Understand mise tasks and runtime pins | [Mise tasks](docs/mise.md) |
| Help as an AI agent | [Agent guide](AGENTS.md) |
| Understand verification and CI | [Agent readiness](docs/agent-readiness.md) |
| Understand GitHub Actions | [GitHub pipelines](docs/github-pipelines.md) |
| Run security checks | [Security audits](docs/security-audits.md) |
| Build React Native apps | [React Native](docs/react-native.md) |
| Contribute changes | [Contributing](CONTRIBUTING.md) |
| Report a vulnerability | [Security](SECURITY.md) |
| Find scripts | [Script guide](scripts/README.md) |

## License

MIT. See [License](LICENSE).
