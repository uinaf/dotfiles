# Software Updates

Topgrade owns the update commands. A per-user LaunchAgent runs the Homebrew
Topgrade executable directly for recurring and on-demand execution. No model
or remote service is involved. Using the real executable also gives macOS a
useful background-item name instead of a generic shell interpreter.

## Schedule And Scope

- Schedule: 00:23, 06:23, 12:23, and 18:23 local time.
- Login/load: one additional pass, including the first enable. This may run
  sooner than six hours after the previous pass.
- Sleep: launchd coalesces missed calendar events into a wake-time pass. It
  does not wake a powered-off machine. Login/load covers the next session.
- Concurrency: launchd runs one instance of the label. On-demand requests use
  that same job without terminating an active update.
- Failure: no KeepAlive loop or interactive retries. A later scheduled pass
  tries again; an operator can request another pass when the problem is fixed.

These are macOS calendar jobs, following
[Apple's scheduling behavior](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/ScheduledJobs.html).

| Surface | Update policy |
| --- | --- |
| Workstation Homebrew | Installed formulae and greedy casks; built-in updater metadata does not exclude an app |
| Shared devbox Homebrew | Excluded from this per-user Topgrade job; use the prefix owner's `brew-devbox.ts` wrapper |
| GitHub CLI extensions | Topgrade's extension updater |
| Managed skills/plugins/MCP setup | Existing `mise run agents:update` task |
| Runtime pins, source checkouts, OS upgrades, reboots | Separate existing owners; not enabled as Topgrade steps |
| Cleanup | Separate maintenance; this job disables implicit Homebrew install cleanup |

The job sets `HOMEBREW_NO_UPGRADE_QUIT_CASKS=1` so Homebrew does not quit running
apps. This does not assert that every vendor installer is disruption-free or
that a running app immediately uses its new version. It never supplies sudo
credentials or interactive input. Privileged or interactive installers may
fail and require an operator run. See the
[Homebrew upgrade options](https://docs.brew.sh/Manpage#upgrade-options-installed_formulainstalled_cask-).

## Enable And Use

From the owning checkout, as the logged-in macOS user:

```sh
mise run dotfiles:apply personal-workstation # choose this user's actual profile
mise run maintenance:enable
mise run maintenance:status
```

Applying dotfiles writes a disabled-by-default plist. Explicit enrollment is
required; there is no chezmoi lifecycle hook that starts updates during apply.
The job depends on this checkout remaining available, its dependencies already
installed, and the user's existing mise/GitHub/agent configuration working in
a non-interactive session. No shell startup or interactive auth is copied into
the job.

Request an update or inspect its output:

```sh
mise run maintenance:update
tail -n 80 ~/Library/Logs/dotfiles/software-update.log
mise run maintenance:status
```

`maintenance:update` acknowledges the request, not completion. Status reports
launchd's state and last exit code. Wait for the active run to finish and read
the Topgrade summary in the log before claiming success.
Scheduled runs have no custom timeout or automatic rollback in this first
integration; a stuck process remains visible as running and prevents overlap.

Use the launchd entrypoint for serialization. Direct interactive `topgrade` remains available
for diagnosis, after confirming the scheduled job is idle.

## Notifications And Logs

- Topgrade requests native macOS notifications on failure only; delivery
  depends on the user's notification permissions and Focus settings.
- Successful and unchanged runs stay silent. Their per-step summaries remain
  in `~/Library/Logs/dotfiles/software-update.log`.
- The log is local and private, and appends across runs. There is no external
  delivery, daily change digest, or independent missed-run monitor yet.
- To archive or truncate the log, wait until the updater is idle. Package
  cleanup and log retention can use the separate host maintenance policy.

launchd records Topgrade's exit code directly, including failed updates.
Failure-only notifications are a native
[Topgrade setting](https://github.com/topgrade-rs/topgrade/blob/v17.9.0/config.example.toml).

## Disable, Reload, And Recover

```sh
mise run maintenance:disable
```

Disabling persists across login and stops an active job, including its child
processes. Prefer doing it after a run finishes. If an update was interrupted,
inspect the log and package state before retrying; don't delete Homebrew locks
while another package operation is running.

After changing plist settings: wait for idle, disable, apply dotfiles, then
enable again. Re-enabling an already loaded job preserves its current process
and does not silently reload the plist.

Headless Unix users without a GUI session need their own host service contract.
Do not install a duplicate system job for the same user or bypass the shared
Homebrew owner wrapper to make this GUI LaunchAgent work remotely.
