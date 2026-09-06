# Software Updates

Topgrade updates installed software and managed agent assets. All profiles
install it and render `~/.config/topgrade.toml`; a per-user LaunchAgent provides
six-hour and on-demand runs for logged-in macOS users.

Preview the selected steps with `topgrade --dry-run`. For an interactive run,
use `topgrade` after checking that the scheduled job is idle.

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
| Shared devbox Homebrew | Excluded from this per-user Topgrade job; use the [prefix owner's wrapper](bootstrap.md#shared-homebrew-updates) |
| GitHub CLI extensions | Topgrade's extension updater |
| Managed skills/plugins/MCP setup | Existing `mise run agents:update` task |
| Runtime pins, source checkouts, OS upgrades, reboots | Separate existing owners; not enabled as Topgrade steps |
| Cleanup | Separate maintenance; this job disables implicit Homebrew install cleanup |

The job sets `HOMEBREW_NO_UPGRADE_QUIT_CASKS=1` so Homebrew does not quit running
apps. Vendor installers may still disrupt an app, and running apps may need a
restart to use the new version. The job supplies no sudo credentials or
interactive input. Privileged or interactive installers may
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
A stuck process remains visible as running and blocks later runs. Inspect its
log before using the [recovery steps](#disable-reload-and-recover); stopping it
does not roll back package changes.

Use `maintenance:update` for serialized runs. A separate `topgrade` or `brew`
process can overlap the scheduled job.

## Notifications And Logs

- Topgrade requests native macOS notifications on failure only; delivery
  depends on the user's notification permissions and Focus settings.
- Successful and unchanged runs stay silent. Their per-step summaries remain
  in `~/Library/Logs/dotfiles/software-update.log`.
- The private local log appends across runs. Archive or truncate it while the
  updater is idle; the scheduler does not rotate it.
- Use `maintenance:status` to check whether the job ran. Failure notifications
  do not detect a scheduler that never started.

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

## Check Available Updates

```sh
mise run maintenance:check
mise run maintenance:verify # after updates; includes full bootstrap verification
```

`maintenance:check` emits a versioned JSON inventory without installing updates.
It refreshes Homebrew metadata and maintains local macOS feed and scan caches;
independent probes run concurrently. Finite probe deadlines send TERM to
only the direct child, escalate to KILL after 200 ms, then stop draining output
after another 200 ms if inherited pipes remain open. Descendants are not
explicitly signaled; closing inherited pipes can still cause EPIPE or SIGPIPE.
Collected output and the direct child's observed exit status are preserved.
A deadline remains a timeout even if TERM causes a successful exit. The
Homebrew probe runs `brew update` before its greedy backlog inventory and reports an incomplete
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
`./scripts/verify/bootstrap.ts --profile <profile> --verbose` only when
successful command output is needed for diagnosis.
