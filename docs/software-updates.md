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

- [Renovate rules](../renovate.json) own reviewed update holds and their rationale.
- [Convergence](../maintenance/converge.ts) requires a clean default
  branch tracking `origin`, with no local commits or unfinished Git operations.
  Dirty, ahead, detached, or diverged checkouts retain local work and fail.
- Commit and push source changes first. The job fast-forwards, trusts updated
  mise tasks, installs locked dependencies, and applies the selected profile.
  Runtime versions follow declarations; [gateway client logins](devbox.md#opt-in-coding-llm-gateway)
  are preserved.
- Shared Homebrew is updated only by its prefix owner. Other users check package
  presence. See [shared Homebrew updates](bootstrap.md#shared-homebrew-updates).
- The shared Homebrew update job runs `brew developer off` first. Any
  `brew audit` or other developer command silently enables developer mode,
  which makes `brew update` track Homebrew `main` instead of stable tags and
  has hung unattended builds on an untagged commit.
- Convergence and shared Homebrew serialize through a
  [checkout lock](../lib/lock.ts). Live or ambiguous owners retain the lock.
- Failed steps retry on the next run. Package/configuration changes are not
  rolled back; Topgrade reports independent steps separately.

## Host Hygiene

[Hygiene policy](../maintenance/hygiene.ts) owns cadence, discovery,
grace periods, and retention checks. Preview before deleting anything:

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
  and [hygiene](../maintenance/hygiene.ts) own retention and size limits.
  History counts are retained totals, not lifetime totals.
- Private receipts live at `~/.local/state/dotfiles/updates/<job>.json`.
  Compare `running` receipts with the scheduler; they do not prove process
  liveness.
- On macOS, `maintenance:status` warns about plist drift and stale receipts.
  Notifications alone cannot detect a scheduler that never starts.

For always-on hosts, provision an owner-only regular file at
`~/.config/dotfiles/update-heartbeats.json` through the host's secret owner:

```json
{
  "software-update": "https://monitor.example/software-heartbeat",
  "homebrew-update": "https://monitor.example/homebrew-heartbeat"
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
- Disabling stops the job and children. After interruption, inspect logs/package
  state before retrying. Never delete Homebrew locks during another package run.

### Upgrading From the Scripts Layout

This breaking release removes the former `scripts/` entry points. Installed
maintenance jobs retain checkout paths, so an unattended pull cannot complete
this migration safely. Stop jobs before pulling; reapply the user configuration
and have an administrator re-enroll macOS update daemons afterward.

1. From the old checkout, inspect each enrolled user's maintenance status and
   wait for active updates to finish. For a user-managed macOS agent or Linux
   timer, stop enrollment as that user:

   ```sh
   mise run maintenance:status
   mise run maintenance:disable
   ```

2. On macOS hosts with system update daemons, an administrator must also stop
   every software/Homebrew update job referencing the checkout being moved.
   Use each existing installed label, including its namespace; replace the
   placeholder below and repeat for each affected job:

   ```sh
   update_label='<installed-update-label>'
   launchctl print "system/$update_label"
   # Wait for the job to finish before disabling and unloading it.
   sudo launchctl disable "system/$update_label"
   sudo launchctl bootout "system/$update_label"
   ```

3. As each checkout owner, run `git pull --ff-only`, then follow
   [Apply a profile](bootstrap.md#apply-a-profile), including verification. Apply replaces the user's plist
   or systemd unit and Topgrade configuration. It does not rewrite root-owned
   LaunchDaemons. Keep schedulers disabled if apply or verification fails.

   If this checkout uses the optional dotfiles pre-push hook, update its stored
   verifier path after preparing dependencies:

   ```sh
   node verify/install-pre-push-hook.ts
   ```

   If gateway clients were previously configured, replace their copied helpers
   with the bundled adapters and verify them:

   ```sh
   node bootstrap/configure-llm-gateway.ts
   node bootstrap/configure-llm-gateway.ts --check
   ```

4. Restore the enrollment that was active before the upgrade. For a user-managed
   agent or timer, run as that user:

   ```sh
   mise run maintenance:enable
   mise run maintenance:status
   ```

   For macOS system jobs, have the administrator rerun the
   [headless enrollment command](#headless-devbox-updates) from the updated
   checkout using the existing user, repository, and namespace. Select
   `--software-updates`; include `--homebrew-updates` only for the previously
   enrolled prefix owner. Repeat with `--check` to verify the new job contract.
   Leave the competing GUI updater disabled. Re-enrollment starts the jobs.

## Headless Devbox Updates

On Linux, `mise run maintenance:enable` plus lingering is the whole
enrollment; the user timer then runs without a login. On a shared Mac, prepare
each user's persistent checkout and apply its devbox profile. As admin:

```sh
sudo node bootstrap/darwin/install-devbox-service-daemons.ts \
  --user example --software-updates --homebrew-updates \
  --updates-repository /Users/example/projects/dotfiles
```

- Only the Homebrew prefix owner gets `--homebrew-updates`; omit it for others.
  Each user must own their checkout/profile. Add `--check` for read-only validation.
- For `personal-solo-devbox`, omit `--homebrew-updates`: the system software
  updater includes Homebrew and records one combined result. It verifies prefix
  ownership and does not run shared-prefix permission repair.
- Disable the user's GUI updater before enrollment. System and GUI enrollment
  reject duplicates. [Devbox scheduling](../maintenance/darwin/devbox.ts)
  owns the staggered schedule; starts do not wait for earlier jobs to finish.
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

### Change a Shared Mac to One Owner

First verify the departing user's destination and recovery, and obtain approval
for account retirement. Preserve the current profile, Topgrade configuration,
and both updater plists for rollback. Wait for both owner's jobs to finish,
then disable and bootout their system labels. Remove the obsolete Homebrew
updater plist explicitly; single-owner enrollment refuses it while present or
loaded. Retire the departing user's jobs separately.

Apply `personal-solo-devbox`, then re-enroll the remaining owner's system
updates without `--homebrew-updates`. Run enrollment again with `--check`,
request an update, and verify its result includes successful package and tool
updates. Keep the GUI updater disabled. After replacement proof, update any
external health consumer to require the combined `software-update` result with
its existing failure and freshness checks, instead of two separate results.

To roll back, wait for the new updater to finish, disable and bootout it,
restore the old profile and configuration, and re-enroll with
`--software-updates --homebrew-updates`. Verify both jobs and restore the
external health contract. Account deletion and credential retirement require
their own recovery procedure.

## Check Available Updates

- `maintenance:check` refreshes Homebrew metadata and reports macOS baselines,
  cached applicability, live-scan decisions, and incomplete/timed-out probes.
  On Linux it has no Homebrew or OS probes; the mise, npm, and coding-agent
  inventories remain.
- [macOS inventory policy](../maintenance/darwin/macos-updates.ts) owns
  cache freshness and live-scan decisions. Stale/unavailable sources remain
  visible; cached applicability is never presented as live. Force a scan with
  `node maintenance/check.ts --fresh`.
- `maintenance:verify` adds bootstrap verification. Live macOS scans have no
  timeout because daemon cancellation is undocumented; inventory never downloads
  or installs OS updates.
