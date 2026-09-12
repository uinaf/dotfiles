# Software Updates

Topgrade updates installed software and applies the enrolled dotfiles profile.

## Enable And Use

Run from the persistent checkout as the logged-in user:

```sh
mise run dotfiles:apply personal-workstation # choose the user's profile
mise run maintenance:enable
mise run maintenance:status
mise run maintenance:update
```

| Command | Purpose |
| --- | --- |
| `maintenance:status` | Loaded state, last exit, receipt, and plist drift |
| `maintenance:check` | JSON update inventory; refreshes metadata without installing |
| `maintenance:verify` | Post-update live macOS scan and full bootstrap verification |
| `maintenance:hygiene` | Cleanup preview; reads remote refs, deletes nothing |
| `maintenance:clean` | Apply eligible cleanup now |
| `maintenance:disable` | Persistently disable and stop the GUI update job |

Prefix these commands with `mise run`.

- Applying dotfiles does not enable updates; enrollment is explicit.
- GUI schedule: 00:23, 06:23, 12:23, 18:23 local time, plus login/load.
  Missed sleep events coalesce on wake; powered-off machines wait until startup.
- On Linux the same commands manage a systemd user timer
  (`dotfiles-software-update.timer`, every six hours with up to fifteen
  minutes of jitter, catching up after downtime). Console output goes to
  `journalctl --user -u dotfiles-software-update`; receipts and history live
  under `~/.local/state/dotfiles`. Homebrew steps are absent there; topgrade
  runs GitHub CLI extension updates plus the managed-dotfiles and hygiene
  commands.
- Requests acknowledge launch, not completion. Check status and the log summary.
  A stuck run blocks later runs.
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

- Playwright CLI stays on `0.1.18`: `0.1.19` dropped npm trusted-publisher
  metadata and provenance. Remove its Renovate hold after a reviewed release
  restores that evidence; keep Mise's trust policy enabled.
- [Convergence](../scripts/maintenance/converge.ts) requires a clean default
  branch tracking `origin`, with no local commits or unfinished Git operations.
  Dirty, ahead, detached, or diverged checkouts retain local work and fail.
- Commit and push source changes first. The job fast-forwards, trusts updated
  mise tasks, installs locked dependencies, and applies the selected profile.
  Runtime versions follow declarations; saved coding-client logins are preserved.
- Shared Homebrew is updated only by its prefix owner. Other users check package
  presence. See [shared Homebrew updates](bootstrap.md#shared-homebrew-updates).
- The update job runs `brew developer off` first. Any `brew audit` or other
  developer command silently enables developer mode, which makes `brew update`
  track Homebrew `main` instead of stable tags; an untagged sandbox commit hung
  unattended builds on the devbox in September 2026.
- Convergence and shared Homebrew serialize through a checkout lock, waiting up
  to 15 minutes. Dead/pre-boot owners are reclaimed; live or ambiguous owners
  retain the lock.
- Failed steps retry on the next run. Package/configuration changes are not
  rolled back; Topgrade reports independent steps separately.

## Host Hygiene

- Runs weekly after success; failed inspections retry at the next update.
- Finds owning clones at `~/projects/<repo>` and `~/projects/<group>/<repo>`.
  Checks current remote default refs using local commit history. Missing history
  or failed remote access retains the repository; sync/fix access before retrying.
- Never removes owning clones. Linked worktrees are eligible under
  `~/.t3/worktrees`, `~/.codex/worktrees`, `~/.claude/worktrees`, and anywhere in
  `~/projects`, so a worktree created beside its owning clone is reported and
  cleaned rather than accumulating unseen.
- Removal requires HEAD ancestry to the remote default and two observations of
  the same HEAD at least **three days apart**. Worktrees also need three days
  without filesystem changes, including their private Git directory.
- Retains dirty, locked, missing, busy, unreadable, or non-canonical
  worktrees; a detached worktree is removable only when its HEAD is already in
  the remote default, since it has no branch to protect; unfinished Git operations; ignored local files except regenerable
  `node_modules`; unmerged/squash-only heads; upstream-tracking and long-lived
  branches (`main`, `master`, `develop`, `dev`, `production`, `staging`, `release`).
  Oversized activity inventories also retain the worktree.
- A branch that is merged upstream but missing from a lagging local checkout
  reports `local default branch is behind the remote; pull before removal`,
  because unforced deletion judges against local HEAD.
- Rechecks remote/Git/process state before unforced removal. Checked-out/default
  branches stay. A removed worktree's branch starts its own three-day grace.
- Read-only activity may leave no timestamps: lock active work explicitly.

```sh
git worktree lock --reason "active agent task" <path>
git worktree unlock <path> # when finished
git config --local dotfiles.hygiene skip # exclude this owning clone
git config --local --unset dotfiles.hygiene # include it again
```

- Cleans aged developer caches/logs (30 days), unavailable simulators,
  unreferenced pnpm entries, and Docker build cache (seven days).
- Preserves project sources, Xcode Archives, npm caches, stopped containers,
  images, and volumes. Shared Homebrew cleanup belongs to its prefix owner.
- Private state: `~/.local/state/dotfiles/hygiene.json`. A live/ambiguous hygiene
  lock fails for inspection; stale process locks recover automatically.

## Notifications And Logs

```sh
tail -n 80 ~/Library/Logs/dotfiles/software-update.log
tail -n 20 ~/Library/Logs/dotfiles/software-update-history-*.log
tail -n 100 ~/Library/Logs/dotfiles/hygiene-*.log
```

- GUI failures request native notifications; permissions/Focus can suppress them.
  Success stays silent. Headless jobs use logs and optional heartbeats.
- JSON history records start/finish, exit code, and heartbeat outcome. Applied
  hygiene logs removals/retentions and cache output; previews/skips do not append.
- Each update archives the previous output. Dated logs retain today and six
  preceding UTC dates; pruning happens during maintenance. Weekly hygiene caps
  logs at 2 MB in place. History counts are retained totals, not lifetime totals.
- Private receipts live at `~/.local/state/dotfiles/updates/<job>.json`.
  Compare `running` receipts with launchd; they do not prove process liveness.
- `maintenance:status` warns about plist drift and receipts older than 13 hours
  while loaded. Notifications alone cannot detect a scheduler that never starts.

For always-on hosts, provision an owner-only regular file at
`~/.config/dotfiles/update-heartbeats.json` through the host's secret owner:

```json
{
  "software-update": "https://monitor.example/software-heartbeat",
  "homebrew-update": "https://monitor.example/homebrew-heartbeat"
}
```

- URLs accept GET for success and GET `/fail` for failure, after completion.
- Delivery has a 15-second timeout, no redirects, and one retry after ten seconds.
  Delivery failure is logged without rerunning updates or changing their exit code.
- Missing config disables delivery; invalid config records failure but updates run.
- Allow scheduling/update grace. Sleeping laptops should not use always-on alerts.

## Disable, Reload, And Recover

- Wait for idle, disable, apply dotfiles, then enable to reload changed plists.
  Re-enabling an already loaded job does not reload it. Script-only changes need
  no launchd reload.
- Disabling stops the job and children. After interruption, inspect logs/package
  state before retrying. Never delete Homebrew locks during another package run.

## Headless Devbox Updates

Prepare each user's persistent checkout and apply its devbox profile. As admin:

```sh
sudo node scripts/darwin/bootstrap/install-devbox-service-daemons.ts \
  --user example --software-updates --homebrew-updates \
  --updates-repository /Users/example/projects/dotfiles
```

- Only the Homebrew prefix owner gets `--homebrew-updates`; omit it for others.
  Each user must own their checkout/profile. Add `--check` for read-only validation.
- Disable the user's GUI updater before enrollment. System and GUI enrollment
  reject duplicates. Jobs run on enrollment/boot and every six hours.
- Homebrew starts at `:00`. Per-user jobs use five-minute slots from `:05` to
  `:50`, selected by `5 × (1 + UID % 10)`; UIDs 502 and 503 run at `:15` and
  `:20`. Slots stagger starts, without waiting for earlier jobs to finish.
- Use the actual installed labels; `kickstart` without `-k` preserves active runs:

```sh
launchctl print system/local.dotfiles.software-update.example
sudo launchctl kickstart system/local.dotfiles.software-update.example
sudo launchctl kickstart system/local.dotfiles.homebrew-update.example
```

To reload, wait for idle, then disable/bootout each affected label and re-enroll:

```sh
sudo launchctl disable system/local.dotfiles.software-update.example
sudo launchctl bootout system/local.dotfiles.software-update.example
```

- Disabled jobs stay disabled across boots; bootout stops active work.
- Returning to GUI updates also requires removing the system plist before
  `maintenance:enable`. See [devbox administration](devbox.md).

## Check Available Updates

- `maintenance:check` refreshes Homebrew metadata and reports macOS baselines,
  cached applicability, live-scan decisions, and incomplete/timed-out probes.
- macOS source caches last 24 hours. Stale/unavailable sources remain visible;
  cached applicability is never presented as live.
- Live scans run when freshness/applicability requires them or after 24 hours.
  Force one with `node scripts/maintenance/check.ts --fresh`.
- `maintenance:verify` adds bootstrap verification. Live macOS scans have no
  timeout because daemon cancellation is undocumented; inventory never downloads
  or installs OS updates.
