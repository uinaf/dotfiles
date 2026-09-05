# Bootstrap Guide

Use this guide when installing or refreshing a Mac from this repository.

The repo has four per-user profiles:

- `workstation` for a portable human-operated development Mac.
- `personal-workstation` for a workstation plus personal packages and skills.
- `personal-devbox` for a devbox plus headless personal tools and skills.
- `devbox` for a remote coding identity on an SSH-first host.

The role contract and host/user boundary are defined in
[User profiles](profiles.md). Run commands from the repo root unless a step
says otherwise.

Cursor:

- Cursor Agent CLI is required for `personal-workstation`, `personal-devbox`,
  `workstation`, and `devbox`, and is installed by
  `./scripts/bootstrap/install.ts`.
- Cursor desktop belongs to the workstation Homebrew layer.
- Devbox shells use Cursor's owner-local file credential store because SSH
  sessions cannot depend on an unlocked macOS login keychain.

SOPS and age:

- Keep the SOPS and age CLIs in the portable Homebrew baseline.
- Require a per-user SOPS age identity only for profiles and workflows that
  decrypt encrypted material: `personal-devbox`, `devbox`, and any
  vault or sudo consumer.
- Portable `workstation` and `personal-workstation` boots can pass readiness
  without an identity; decryption stays fail-closed until one is provisioned.
- When you do create an identity, follow
  [Identity provisioning](identities.md), back it up through an approved human
  recovery system, and verify the restored recipient before protecting live
  ciphertext.

## First-Time Prerequisites

Install Apple Command Line Tools:

```zsh
xcode-select --install
```

Install Homebrew:

```zsh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Install the minimum tools needed to clone the repo on a workstation Mac:

```zsh
brew install git gh
gh auth login
```

On a shared devbox, scope the owner-only umask directly because the repo
wrapper is not available until after this first clone:

```zsh
(umask 0027; brew install git gh)
gh auth login
```

Clone the repo:

```zsh
mkdir -p ~/projects
gh repo clone uinaf/dotfiles ~/projects/dotfiles
cd ~/projects/dotfiles
brew install mise
./dotfiles prepare
export PATH="$(mise --no-config where node@24.19.0)/bin:$PATH"
```

`./dotfiles prepare` installs the pinned Node runtime and locked repository
dependencies before any TypeScript entrypoint runs. It does not apply a profile.

Trust this checkout after the bundle step and before `mise tasks` or `mise run ...`.

## Gitless First Fetch

Use this only when a fresh Mac cannot run `git` or `gh` yet. macOS ships enough
tools to fetch a public GitHub archive, which lets a human or agent inspect the
bootstrap files before running anything:

```zsh
mkdir -p ~/projects
curl -fL https://github.com/uinaf/dotfiles/archive/refs/heads/main.zip \
  -o /tmp/dotfiles-main.zip
ditto -x -k /tmp/dotfiles-main.zip ~/projects
mv ~/projects/dotfiles-main ~/projects/dotfiles
cd ~/projects/dotfiles
```

Before running TypeScript scripts from this archive, install Homebrew and run
`brew install mise`, then `./dotfiles prepare` and export the Node `PATH`
shown in the clone steps above.

Archive checkouts are disposable:

- Reading docs and running the first public bootstrap scripts is supported.
  `scripts/bootstrap/install.ts` can install files from an archive checkout.
- After Homebrew, `git`, and `gh` are installed, replace the archive with a real
  clone so updates, diffs, hooks, and contribution checks work normally:

```zsh
cd ~/projects
mv dotfiles dotfiles.archive.$(date +%Y%m%d%H%M%S)
gh repo clone uinaf/dotfiles dotfiles
cd dotfiles
```

Do not run identity, signing-key, or secret setup from guessed values just
because the repo was fetched this way. Keep using the selected
profile steps below.

## Human Workstation Macs

Use `workstation` for the portable developer baseline or when another trusted
system owns selected software. Use `personal-workstation` when this repository
should also own the personal package and skill layers.

Install Homebrew dependencies:

```zsh
profile=workstation # use personal-workstation for the personal layers
./scripts/bootstrap/brew-bundle.ts "$profile"
```

The script trusts each third-party tap declared in the selected Brewfiles
(`brew trust`) before bundling; Homebrew versions without trust enforcement
skip the step.

For externally supplied Brewfile entries, or a managed Homebrew that refuses
tap trust, configure the local validation contract in
[User profiles](profiles.md#externally-managed-homebrew-capabilities).

On `personal-workstation` only, remove bundled Mac App Store apps this setup
does not use:

```zsh
./scripts/app-store/personal.ts
```

This uses `mas`, which discovers installed apps through Spotlight, and may ask
for the local account password during uninstall.

Install optional shell customization:

```zsh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
```

Fonts and terminal:

- Editor and terminal defaults prefer `Berkeley Mono Variable`.
- This repo does not install that font because it is licensed; ask the human to
  provide and install it when available.
- Ghostty falls back to `Menlo`, which ships with macOS and needs no extra font
  package.
- The managed Ghostty config enables its `ssh-env` and `ssh-terminfo` shell
  integration features.
- Interactive SSH connections install Ghostty's terminfo entry on the remote
  host when possible, and fall back to `xterm-256color` when installation is
  unavailable. See
  [Ghostty SSH integration](https://ghostty.org/docs/features/ssh).

`./scripts/bootstrap/install.ts` uses Codex's config API to update selected
defaults in `~/.codex/config.toml`:

- Removes the legacy `forced_login_method` setting so each identity can use its
  active ChatGPT session or an explicitly configured API provider without the
  bootstrap overriding that choice.
- Selects GPT-6 Astra with medium reasoning effort.
- Enables Fast mode for personal profiles. Standard profiles leave the service
  tier and Fast mode keys absent.
- Preserves unrelated settings and formatting.
- Does not manage Codex auth tokens, sessions, approvals, or app state.

The typed edit list in `scripts/bootstrap/configure-codex.ts` is the source of
truth; the bootstrap client sends it through Codex's native writer as one
atomic update.

Developer profiles also select Claude Fable 5.1 with medium effort and Cursor
Grok 4.6 High. Personal profiles select Cursor's Fast variant. Grok Build on
personal workstations defaults to Grok 4.6 through the managed gateway config.

Personal profiles then require the owner-only LLM gateway config, apply it to
Codex, Claude Code, Cursor Agent, and Grok Build, and retire their saved vendor
login sessions. Workstation profiles manage the T3 Code, ChatGPT, Claude, and
Cursor desktop apps.

The same install step also:

- Installs or updates GitHub's official `github/gh-stack` extension through
  `gh extension install --force`. GitHub CLI authentication and other
  extensions remain machine-local.
- Applies mise's trusted Codex and Claude worktree roots and runs the agent
  worktree mise trust helper. Use the matching task in
  [Mise tasks](mise.md#task-namespaces) to refresh local trust after new
  worktrees are created.
- Runs the machine-global instruction and additive skill sync described in
  [Agent setup](agents.md).

Remote Codex connections are also manual user config. If the machine should use
them, ask the human to add this to `~/.codex/config.toml`:

```toml
[features]
remote_connections = true
```

Apply dotfiles and configure local state:

```zsh
profile=workstation # use personal-workstation for the personal layers
mise trust
./dotfiles diff "$profile"
./dotfiles apply "$profile"
# Optional for workstation/personal-workstation; required for secret-consuming profiles:
# ./scripts/secrets/configure-sops-age-identity.ts
./scripts/bootstrap/configure-git.ts --profile "$profile"
./scripts/bootstrap/configure-power.ts --profile "$profile"
./scripts/bootstrap/configure-spotlight.ts
```

What each step does:

- The installer applies the profile's dotfiles, installs its mise runtimes, then
  configures the remaining integrations.
- The developer mise config pins Node, enables the stable Corepack-managed pnpm
  default, and installs exact shared npm and Playwright CLI versions. Vite+
  stays repository-local.
- The dotfile step applies the repo-local chezmoi source state from `chezmoi/`.
  Preview the whole per-user flow with `./dotfiles diff "$profile"`.
- The power step disables system, display, and disk sleep only while the Mac is
  plugged in. Battery settings stay under macOS defaults so laptops still sleep
  normally when unplugged. It prompts for sudo; `./dotfiles apply` remains a
  user-level convergence step.
- `configure-spotlight.ts` is the same host-wide baseline for workstation and
  devbox Macs: it disables indexing on mounted volumes without deleting existing
  index data.

Chrome Lens is disabled for every profile through `defaults write
com.google.Chrome` policies (`SearchContentSharingSettings`,
`LensOverlaySettings`, `LensRegionSearchEnabled`, `LensDesktopNTPSearchEnabled`);
the old `chrome://flags` override for the "Ask Google" chip expired in Chrome 145.
Vertical tabs remain a Local State flag. Quit Chrome first, then:

```zsh
./scripts/bootstrap/configure-chrome.ts
```

### Git Identity

Configure explicit authorship, local SSH signing, and GitHub SSH authentication
through the developer flow in [Identity provisioning](identities.md#developer-git-and-ssh).
Keep the private key owner-only and outside this repository.

Verify:

```zsh
mise run maintenance:check
./dotfiles check "$profile"
mise run audit host
mise run audit workstation
```

`maintenance:check` emits a versioned, read-only JSON snapshot and runs
independent inventory probes concurrently. Finite probe deadlines send TERM to
only the direct child, escalate to KILL after 200 ms, then stop draining output
after another 200 ms if inherited pipes remain open. Descendants are not
explicitly signaled; closing inherited pipes can still cause EPIPE or SIGPIPE. Collected output and the direct child's observed exit status are
preserved, and a deadline remains a timeout even if TERM causes a successful
exit. The Homebrew probe explicitly runs
`brew update` before its greedy backlog inventory and reports an incomplete
snapshot when the refresh fails. Its macOS update inventory reports:

- installed macOS version and build plus the installed Safari version;
- Apple GDMF and advisory SOFA release baselines with source and freshness;
- the device's cached applicable backlog from `softwareupdate --list
  --no-scan`, labeled `cached_previous_scan`;
- whether a live scan ran, why it ran, and whether applicability is current,
  unknown, or has updates available.

Apple GDMF responses are cached for 24 hours under
`~/.cache/dotfiles/macos-updates/`. SOFA requests send an explicit User-Agent.
Stale, malformed, incompatible, or unavailable sources stay visible in the
snapshot; cached applicability is never labeled live.

The routine path runs `softwareupdate --list` when upstream is newer, cached
applicability is non-empty or invalid, fresh applicability cannot otherwise be
established, or the last successful live scan is at least 24 hours old. The
successful live-scan timestamp is stored beside the GDMF cache. Request an
unconditional live scan with:

```zsh
node ./scripts/maintenance/check.ts --fresh
```

After maintenance, use `mise run maintenance:verify`; it runs the live scan and
adds the full bootstrap gate. A live scan has no timeout because the macOS
client does not document daemon-side cancellation. The inventory never runs
`softwareupdate --background`, downloads, or installs updates. Run
`./scripts/verify/bootstrap.ts --profile "$profile" --verbose` only when
successful command output is needed for diagnosis.

## Devbox Mac

Use `devbox` for the standard shared-host contract. Use `personal-devbox` for
the same host shape plus additive headless personal tools and skills.

The human owner profile may opt into the compact desktop baseline. It is not
part of the shared agent-user bootstrap:

```zsh
./scripts/bootstrap/configure-desktop.ts
./scripts/verify/bootstrap.ts --profile devbox --desktop
```

This keeps the built-in black system wallpaper, hidden desktop icons and
widgets, an auto-hiding compact Dock, no recent apps, and Google Chrome as the
only persistent Dock app. Run it only from the logged-in owner account.

Install shared plus devbox Homebrew dependencies:

```zsh
profile=devbox # use personal-devbox for headless personal tools and skills
./scripts/bootstrap/brew-bundle.ts "$profile"
```

Run every other Homebrew mutation on a shared devbox through the repo wrapper:

```zsh
./scripts/bootstrap/brew-devbox.ts upgrade
./scripts/bootstrap/brew-devbox.ts upgrade --cask
```

Wrapper contract:

- Requires the current Unix user to own the Homebrew prefix.
- Scopes an owner-write, group-read umask to the Homebrew child process. The
  caller's shell umask is unchanged.
- Restores group read and traverse permissions while removing group write from
  prefix-owner-owned content, including macOS symlinks, after every attempted
  mutation and preserves Homebrew's exit status.
- Refuses mutations when any prefix content has another owner or remains group
  writable. Devbox shells also disable implicit Homebrew auto-update.
- Never changes content owned by another Unix identity.
- The devbox bundle command uses the wrapper internally.

Run these commands once from the owning admin identity, then run the devbox
bootstrap verification as every Unix identity. Verification disables Homebrew
auto-update so a read-only package check cannot mutate the shared checkout.

Apply dotfiles:

```zsh
mise trust
./dotfiles diff "$profile"
./dotfiles apply "$profile"
./scripts/secrets/configure-sops-age-identity.ts
./scripts/bootstrap/configure-power.ts --profile "$profile"
./scripts/bootstrap/configure-spotlight.ts
```

What each step does:

- The installer applies the developer runtime pins before typed agent sync.
  Mise installs Node, the stable Corepack-managed pnpm default, and exact shared
  npm and Playwright CLI versions. Vite+ stays repository-local.
- The power step keeps plugged-in devboxes awake for agents, remote access, and
  always-on dashboards. It leaves battery settings untouched and prompts for
  sudo instead of hiding system changes inside `install.ts`.
- The Spotlight step is the same host-wide baseline used by workstation Macs.

Configure local Git identity from explicit values. Do not invent these for the
user. On headless devboxes, prefer a human-provisioned local SSH key file over
GUI SSH agents:

```zsh
GIT_USER_NAME='Devbox Name' \
GIT_USER_EMAIL='devbox@example.com' \
GIT_SIGNING_KEY="$HOME/.ssh/devbox-key" \
  ./scripts/bootstrap/configure-git.ts --profile "$profile" --non-interactive
```

See [Developer Git and SSH](identities.md#developer-git-and-ssh) for key
requirements, separate authentication keys, and the managed GitHub SSH block.

If the devbox runs long-lived workspace or agent services, follow
[Devbox setup](devbox.md). Provision and back up the dedicated SOPS age
identity, keep plaintext out of default shells and service configuration, and
let each workspace own its narrow SOPS consumers.

Verify each devbox user:

```zsh
mise run maintenance:check
./dotfiles check "$profile"
mise run audit host
./scripts/verify/devbox-services.ts
mise run audit devbox
```

## Updating an Existing Machine

Pull the repo and rerun the relevant profile:

```zsh
cd ~/projects/dotfiles
git pull --ff-only
profile=workstation # use personal-workstation for the personal layers
./scripts/bootstrap/brew-bundle.ts "$profile"
mise trust
./dotfiles diff "$profile"
./dotfiles apply "$profile"
# Optional for workstation/personal-workstation; required for personal-devbox/devbox:
./scripts/secrets/configure-sops-age-identity.ts
./scripts/bootstrap/configure-power.ts --profile "$profile"
./scripts/bootstrap/configure-spotlight.ts
./dotfiles check "$profile"
```

Use the target Unix user's `personal-devbox` or `devbox` role instead when
appropriate, and keep the age-identity step for those profiles.

## Mobile and TV Development

Xcode tvOS simulators, Android SDK, Android TV system images, CocoaPods, and
Fastlane are per-machine state set up by hand. See
[Mobile and TV development](mobile-and-tv-development.md) for the manual steps.

## Tizen

Tizen certificates, profiles, archives, and device keys are local secrets.
They do not belong in Git.

Helpers live under `scripts/tizen/`:

```zsh
./scripts/tizen/install.ts
./scripts/tizen/pack.ts
./scripts/tizen/restore.ts
./scripts/tizen/restore-from-1password.ts
```

`scripts/tizen/install.ts` verifies `tizen`, `sdb`, and
`package-manager-cli show-info`. It skips package catalog listing by default;
use `--show-pkgs` only when needed because Samsung's extension catalog download
can hang.

## Troubleshooting

- If `brew bundle check` fails, run the matching `brew-bundle.ts` profile and
  retry verification.
- If the `brew bundle drift` verification fails, packages are installed that no
  profile layer declares (usually casks dropped from a Brewfile, which
  `brew bundle` never uninstalls). Run
  `./scripts/bootstrap/brew-bundle.ts --cleanup <profile>` to remove them.
  Shared devbox prefixes compare and clean against the personal-devbox layers
  so one Unix user cannot remove another active profile's packages.
- If historical prefix-owner content has incorrect group permissions, run
  `brew-devbox.ts --repair-shared-readability` as the prefix owner, then retry
  verification. The repair is owner-scoped; reassign content owned by another
  identity to the prefix owner through the host's approved administrator path.
- If `chezmoi` is missing, rerun `./scripts/bootstrap/brew-bundle.ts` for the
  correct profile before `./dotfiles apply <profile>`.
- If Git reports dubious ownership under `/opt/homebrew`, rerun
  `configure-git.ts` for the correct profile.
- If `git@github.com` fails on a devbox profile but the key is present, rerun
  `configure-git.ts --profile devbox --non-interactive` (or use
  `personal-devbox`) with
  `GIT_SIGNING_KEY` or `GIT_SSH_IDENTITY_FILE` pointing at the owner-only local
  private key file.
- If shared env access is missing over SSH, check the SOPS recipient and
  deployment identity in [Devbox setup](devbox.md) instead of exporting service
  tokens in shell startup.
- If `codex` is not installed yet for a developer-profile user, install the
  developer Homebrew layer before rerunning `./dotfiles apply <profile>`.
- If macOS Gatekeeper blocks an embedded Cursor Agent `.node` module, remove a
  Homebrew `cursor-cli` cask installation and run
  `./scripts/bootstrap/install-cursor-agent.ts`. The repo intentionally uses
  Cursor's official per-user installer instead of recursively removing
  quarantine attributes from a Homebrew cask.
