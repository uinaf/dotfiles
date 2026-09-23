# Software Updates

Topgrade updates installed software and applies the enrolled dotfiles profile.
A launchd agent schedules it on macOS; a systemd user timer does on Linux.
[schedule.ts](../maintenance/schedule.ts) routes the commands below to
the platform implementation.

## Enable And Use

Complete [profile setup](bootstrap.md#apply-a-profile), then run from the
persistent checkout as the logged-in user:

```sh
mise run maintenance:enable
mise run maintenance:status
mise run maintenance:update
```

Use `mise tasks` for the command catalog. Schedules live in the
[macOS agent](../chezmoi/private_Library/LaunchAgents/local.dotfiles.software-update.plist.tmpl)
and [Linux timer](../chezmoi/private_dot_config/systemd/user/dotfiles-software-update.timer).

- Applying dotfiles does not enable updates; enrollment is explicit.
- macOS missed sleep events coalesce on wake; powered-off machines wait until
  startup. Linux catches up after downtime.
- Linux `maintenance:enable` needs the rendered units and systemd lingering
  (`sudo loginctl enable-linger <user>`, an administrator step); without
  lingering the timer stops at logout and `maintenance:status` fails. Console
  output goes to `journalctl --user -u dotfiles-software-update`. The
  [Topgrade config](../chezmoi/private_dot_config/topgrade.toml.tmpl) selects
  update steps; the host owns Linux packages.
- Requests acknowledge launch, not completion. Check status and the log summary.
  Updates have a one-hour execution limit. A timeout captures diagnostics,
  stops the observed update processes, reports exit code `124`, and sends a
  failure heartbeat. The next scheduled run can proceed after cleanup succeeds.
- `maintenance:update` preserves an active run. Separate `topgrade` or `brew`
  processes can overlap it; check for idle before interactive work.
- No sudo credentials or interactive input are supplied. Privileged installers
  may require an operator run. Homebrew is told not to quit running casks;
  vendor installers can still disrupt apps.
- OS installation, reboots, machine provisioning, identity enrollment, and
  remote services remain separate operations.
- Full Xcode follows [the declared pin](../chezmoi/.chezmoidata/xcode.json).
  Install or select it with `mise run xcode:install`; the scheduled updater
  does not. Live bootstrap verification checks the selected release.

## Dotfiles Convergence

- [Renovate rules](../renovate.json) own reviewed update holds and their rationale.
- [Convergence](../maintenance/converge.ts) requires a clean default
  branch tracking `origin`, with no local commits or unfinished Git operations.
  Dirty, ahead, detached, or diverged checkouts retain local work and fail.
- Commit and push source changes first. The job fast-forwards, trusts updated
  mise tasks, installs locked dependencies, and applies the selected profile.
  Runtime versions follow declarations; [gateway client logins](devbox.md#opt-in-coding-llm-gateway)
  are preserved.
- Homebrew updates run as its prefix owner. The [Topgrade template](../chezmoi/private_dot_config/topgrade.toml.tmpl)
  disables Homebrew developer mode before updates so they follow stable tags.
- Concurrent convergence runs serialize through a [checkout lock](../lib/lock.ts).
  Live or ambiguous owners retain the lock.
- Failed steps retry on the next run. Package/configuration changes are not
  rolled back; Topgrade reports independent steps separately.

## Host Hygiene

[Hygiene](../maintenance/hygiene.ts) coordinates scheduled cleanup.
[Repository cleanup](../maintenance/repositories.ts) owns discovery, eligibility,
grace periods, and removal revalidation. Preview before deleting anything:

```sh
mise run maintenance:hygiene
mise run maintenance:clean # apply with the updater idle
```

- Cleanup removes eligible merged worktrees and branches after a grace period,
  plus aged developer caches. It never removes owning clones.
- Dirty, locked, active, or unproven work stays. Missing history or failed
  inspection retains candidates; resolve the reported cause before retrying.
  A lagging local default branch can require a pull before removal.
- Read-only activity may leave no timestamps: lock active work explicitly or
  exclude the owning clone:

```sh
git worktree lock --reason "active agent task" <path>
git worktree unlock <path> # when finished
git config --local dotfiles.hygiene skip # exclude this owning clone
git config --local --unset dotfiles.hygiene # include it again
```

- The [cache sweep](../maintenance/cache-cleanup.ts) owns cleanup targets
  and age thresholds. It preserves project sources and persistent container
  data; review the preview for the current targets. Shared Homebrew cleanup
  belongs to its prefix owner.
- The sweep deletes Codex conversation history, which Codex itself never
  reclaims. Archived sessions go after 30 days, live sessions after 90,
  visualizations after 30, and `.tmp` scratch after 7, under `CODEX_HOME` when
  set. Deletion is permanent and has no Codex-side undo, so preview before
  applying. Config, skills, memories, plugins, worktrees, and the sqlite
  databases sit at the Codex root and are never swept.
- Two consequences follow from deleting rollout files directly. Codex keeps
  thread rows in `state_*.sqlite` and `session_index.jsonl`, so a pruned session
  can still be listed while no longer opening, and the databases do not shrink;
  reclaim those with Codex's own `codex delete`. Archiving also preserves the
  original mtime, so a session archived long after its last activity is eligible
  immediately rather than 30 days later.
- Private state: `~/.local/state/dotfiles/hygiene.json`. A live/ambiguous hygiene
  lock fails for inspection; stale process locks recover automatically.

## Notifications And Logs

```sh
tail -n 80 ~/Library/Logs/dotfiles/software-update.log
tail -n 20 ~/Library/Logs/dotfiles/software-update-history-*.log
tail -n 100 ~/Library/Logs/dotfiles/hygiene-*.log
```

On Linux the console stream is in the user journal
(`journalctl --user -u dotfiles-software-update`) and the history and hygiene
logs live under `~/.local/state/dotfiles/logs/`.

- macOS GUI failures request native notifications; permissions/Focus can
  suppress them. Success stays silent. Headless jobs use logs and optional
  heartbeats.
- JSON history records start/finish, exit code, and heartbeat outcome. Applied
  hygiene logs removals/retentions and cache output; previews/skips do not append.
- Each update archives the previous output; [log policy](../maintenance/logs.ts)
  owns retention and size limits.
  History counts are retained totals, not lifetime totals.
- Private receipts live at `~/.local/state/dotfiles/updates/<job>.json`.
  Compare `running` receipts with the scheduler; they do not prove process
  liveness. An update starts only after its initial receipt is saved. History
  logging remains best-effort; missing executables remain retryable after repair.
- The latest timeout report lives at
  `~/.local/state/dotfiles/updates/diagnostics/software-update-timeout.json`.
  It is owner-only, survives reboot, and is replaced on the next timeout.
  Reports include process identities and bounded macOS stack samples, excluding
  command arguments and environment values. Linux reports process metadata.
  Diagnostic failure does not prevent process cleanup or failure reporting.
- On macOS, `maintenance:status` inspects the GUI updater or, when absent, the
  system updater under the stored host namespace. It reports the selected domain
  and compares that job’s plist and the user’s receipt without changing enrollment.
  It warns about plist drift and stale receipts.
  Notifications alone cannot detect a scheduler that never starts.

For always-on hosts, provision an owner-only regular file at
`~/.config/dotfiles/update-heartbeats.json` through the host's secret owner:

```json
{
  "software-update": "https://monitor.example/software-heartbeat"
}
```

- URLs accept GET for success and GET `/fail` for failure, after completion.
- [Heartbeat delivery](../maintenance/run.ts) is bounded and does not
  follow redirects. Failure is logged without rerunning updates or changing
  their exit code.
- Missing config disables delivery; invalid config records failure but updates run.
- Allow scheduling/update grace. Sleeping laptops should not use always-on alerts.

## Disable, Reload, And Recover

```sh
mise run maintenance:status
mise run maintenance:disable
```

- macOS: wait for idle, disable, apply dotfiles, then enable to reload changed
  plists. Re-enabling an already loaded job does not reload it. Script-only
  changes need no launchd reload.
- Linux: `./dotfiles apply` runs `systemctl --user daemon-reload`, so changed
  units take effect without re-enrolling.
- Disabling stops the job and children. An interrupted run leaves its receipt
  at `cleanupComplete: false`; inspect logs/package state before retrying. Never delete Homebrew locks during another package run.
- Deadline cleanup tracks same-user descendants across process sessions,
  checks recorded start times before signaling, and escalates from TERM to KILL.
  A process that detaches and loses its parent before observation can escape
  tracking. If a receipt reports `cleanupComplete: false`, inspect remaining
  processes before requesting another run. Later runs refuse to start and report
  exit code `125` until the incomplete or unreadable receipt is removed, or when
  they cannot save their own gate receipt. Remove
  `~/.local/state/dotfiles/updates/software-update.json` only after verifying the
  previous update and its descendants have stopped. This bounds a stuck updater;
  it does not repair the underlying package or operating-system failure.

## Headless Devbox Updates

On Linux, `mise run maintenance:enable` plus lingering is the whole
enrollment; the user timer then runs without a login. On a Mac, prepare
the owner's persistent checkout and apply its devbox profile. As admin:

```sh
sudo node bootstrap/darwin/install-devbox-service-daemons.ts \
  --user example --software-updates \
  --updates-repository /Users/example/projects/dotfiles
```

- The selected user must own the Homebrew prefix and checkout/profile. The
  system software updater includes packages and tools in one result. Add
  `--check` for read-only validation.
- Disable the user's GUI updater before enrollment. System and GUI enrollment
  reject duplicates. [Devbox scheduling](../maintenance/darwin/devbox.ts)
  owns the schedule.
- Use the actual installed labels; `kickstart` without `-k` preserves active runs:

```sh
launchctl print system/local.dotfiles.software-update.example
sudo launchctl kickstart system/local.dotfiles.software-update.example
```

To reload, wait for idle, then disable/bootout each affected label and re-enroll:

```sh
sudo launchctl disable system/local.dotfiles.software-update.example
sudo launchctl bootout system/local.dotfiles.software-update.example
```

- Disabled jobs stay disabled across boots; bootout stops active work.
- Returning to GUI updates also requires removing the system plist before
  `maintenance:enable`. See [devbox administration](devbox.md).

### Change a Shared Mac to One Owner

First verify the departing user's destination and recovery, and obtain approval
for account retirement. Preserve the current source revision, profile, Topgrade configuration,
and both updater plists for rollback. Wait for both owner's jobs to finish,
then disable and bootout their system labels. Remove the obsolete Homebrew
updater plist explicitly; single-owner enrollment refuses it while present or
loaded. Retire the departing user's jobs separately.

Apply `personal-devbox`, then re-enroll the remaining owner's system
updates. Run enrollment again with `--check`,
request an update, and verify its result includes successful package and tool
updates. Keep the GUI updater disabled. After replacement proof, update any
external health consumer to require the combined `software-update` result with
its existing failure and freshness checks, instead of two separate results.

To roll back, wait for the new updater to finish, disable and bootout it,
restore the old source revision, profile, configuration, and saved plists.
Verify the restored jobs and restore the
external health contract. Account deletion and credential retirement require
their own recovery procedure.

## Check Available Updates

- `maintenance:check` refreshes Homebrew metadata and reports macOS baselines,
  cached applicability, live-scan decisions, and incomplete/timed-out probes.
  On Linux it has no Homebrew or OS probes; the mise, npm, and coding-agent
  inventories remain.
- Coding-agent version probes include the user's managed `~/.local/bin` wrappers
  and mise shims even in noninteractive SSH sessions. Gateway wrappers remain
  the executable boundary.
- Homebrew cask receipts are compared with installed bundle versions from
  `brew info --json=v2`. Exact target matches appear under `record_lag` and do
  not count toward the backlog. Mismatches remain pending; missing app versions
  or failed inspection remain `unknown` and count toward the backlog. This
  includes package-based casks without a readable app bundle. Self-update
  metadata alone never establishes currentness.
- [macOS inventory policy](../maintenance/darwin/macos-updates.ts) owns
  cache freshness and live-scan decisions. Stale/unavailable sources remain
  visible; cached applicability is never presented as live. Force a scan with
  `node maintenance/check.ts --fresh`.
- `maintenance:verify` adds bootstrap verification. Live macOS scans have no
  timeout because daemon cancellation is undocumented; inventory never downloads
  or installs OS updates.

## Development Workload Diagnostics

On macOS, run as the development user from the prepared checkout:

```sh
node maintenance/workloads.ts
```

This read-only process snapshot reports adopted Gradle test workers, temporary
Bun/Node test or daemon arguments, and test-like PostgreSQL data directories as
candidates for manual inspection. It also reports observed Colima VM helpers,
ADB servers, and Watchman. Age is context, never proof of abandonment.

Only the current user's processes are inspected. Output contains fixed service
names, PIDs, ages, and evidence; arguments and paths are not printed. No daemon
clients are contacted, so the command cannot prove a VM is empty, a database has
no clients, ADB has no devices, or Watchman has unused roots. Legitimate services
can match the candidate rules. Confirm ownership and current use before stopping
anything. Other users' workloads and unrecognized process layouts are outside
this snapshot. Missing/failed process inspection or malformed rows produce an
incomplete result and nonzero exit; Linux is currently unsupported.

## CLI Release Policy

The [Renovate rules](../renovate.json) give the listed CLI tools a separate
patch/minor group with no release-age or time-of-day restriction. Required CI
still gates merges; majors retain the shared manual policy. Runtime pins keep
their one-day gate, package-manager and release-tool holds remain separate,
and new tools require an explicit policy choice.

The [mise settings](../chezmoi/private_dot_config/mise/config.toml.tmpl) exclude
those same CLI tools from mise's default 24-hour release-age filter. Other
tools retain that filter. Project-specific per-tool settings and the command-line
`--minimum-release-age` flag take precedence. Mise's `latest` command reports a
version; it does not advance an exact template pin or install an update.

Renovate advances the plain TOML pins after discovering a release. Once its
change lands, apply it from a clean default-branch checkout:

```sh
node maintenance/converge.ts
mise latest github:anthropics/claude-code
mise exec -- claude --version
```

Convergence fast-forwards the checkout, renders the global mise configuration,
and runs `mise install`. Claude Code uses the GitHub backend on macOS and Linux;
older ubi installations can remain until the replacement is verified. The bot's
own run cadence and cached release catalogs can still delay discovery. For a
fresh diagnostic without changing pins, run
`mise cache clear github:anthropics/claude-code`, then repeat `mise latest`.

### GitHub Authentication

Mise obtains credentials through `gh auth token` for the requested GitHub host,
including credentials stored in the system keyring. The installed launcher uses
`gh` on PATH or resolves an already-installed copy offline when only mise shims
were available. It never installs a credential helper or writes a token to disk.
A fresh host without an authenticated `gh` falls back to unauthenticated public
requests until the operator runs `gh auth login --hostname github.com`.

Check the selected source with `mise token github` (masked output). Explicit
`MISE_GITHUB_TOKEN`, `GITHUB_API_TOKEN`, or `GITHUB_TOKEN` environment variables
take precedence over the credential command. Scheduled runs need access to the
same user's credential store; the launcher cannot unlock a locked keyring.
