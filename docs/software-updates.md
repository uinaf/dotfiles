# Software Updates

Topgrade updates installed software and converges the enrolled dotfiles checkout. All profiles
install it and render `~/.config/topgrade.toml`; a per-user LaunchAgent provides
six-hour and on-demand runs for logged-in macOS users. Devboxes can enroll
system LaunchDaemons that run as each selected user without a GUI login.

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
| Shared devbox Homebrew | Separate system job under the prefix owner, through the [shared wrapper](bootstrap.md#shared-homebrew-updates) |
| GitHub CLI extensions | Topgrade's extension updater |
| Dotfiles source and configuration | Fast-forward a clean default branch, install locked dependencies, then apply the selected profile |
| Runtime versions and declared packages | Install the versions and packages declared by the updated profile |
| Managed skills/plugins/MCP setup | Update selected skills/plugins and sync MCP registrations through the profile installer |
| OS upgrades, reboots, remote services | Separate owners; not enabled by this job |
| Host hygiene | Weekly eligible worktree/branch retirement and aged cache cleanup; implicit Homebrew install cleanup stays disabled |

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
The job depends on this checkout remaining available, its bootstrap tools being
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

## Dotfiles Convergence

The custom `Managed dotfiles` step runs `scripts/maintenance/converge.ts`:

1. Require a clean default branch tracking `origin`, with no local commits or
   unfinished Git operation; fetch and fast-forward without stashing or rebasing.
2. Trust its updated mise tasks and use `./dotfiles maintain` to select the
   repository's Node pin, install locked dependencies, and start the updated
   installer in a fresh process.
3. Install missing Homebrew declarations without cleanup. On shared hosts,
   only the prefix owner installs them; other users check their required packages.
4. Apply chezmoi configuration with the existing backups, install declared mise
   versions, refresh repository dependencies, and run the selected profile setup.
5. Update Cursor Agent, GitHub extension declarations, coding-client settings,
   global agent rules, skills, plugins, and MCP registrations through their
   existing installers. Maintenance preserves saved coding-client logins.

The enrolled checkout's default branch is the trusted policy source. Runtime
versions follow its declarations; the job does not rewrite pins to arbitrary
latest versions. Source changes must be committed and pushed before a job can
apply them. A dirty, ahead, detached, or diverged checkout fails this step and
keeps local work. Resolve that checkout before requesting another run.

Convergence and the scheduled shared Homebrew wrapper use the same checkout
lock. A competing run fails visibly and can be retried after the active one
finishes. After a killed process, inspect the job and its children before
removing the empty lock directory reported in the log. Failed apply steps are
retried on the next run; package and configuration changes are not rolled back.
Topgrade still reports its other independent steps separately.

This applies the per-user profile installer. Machine provisioning, Git/SSH
identity enrollment, macOS updates, remote MCP deployment, and service
restarts/version changes remain with their explicit owners. Plist changes are
written to disk; reload an enrolled job with the recovery procedure below to
activate new launchd settings.

## Host Hygiene

Topgrade's `Host hygiene` command runs `scripts/maintenance/hygiene.ts` under
this user's existing update job. It runs at most weekly after success; a
failed inspection retries at the next update. Successfully cleaned caches
remain on their weekly interval during those retries. It also supports:

```sh
mise run maintenance:hygiene # preview; checks remote refs, deletes nothing
mise run maintenance:clean   # apply eligible cleanup now
```

Repository discovery covers owning checkouts at `~/projects/<repo>` and
`~/projects/<group>/<repo>`, without following symlinks or treating linked
checkouts as owning clones. It reads each origin's current default branch and
commit SHA, then uses the commit graph already on disk. Missing history is
reported and retained for normal repository sync. Cleanup prunes stale
origin-tracking refs, but never downloads Git objects, pulls, rebases, or
removes an owning checkout. Missing checkouts are not cloned by cleanup.
Repositories without a possible worktree or branch retirement target skip
remote checks entirely. Remote access failures retain that repository and
fail the cleanup run; resolve its normal Git access before retrying.

Linked worktrees are eligible only below `~/.t3/worktrees`,
`~/.codex/worktrees`, or `~/.claude/worktrees`. Their HEAD must already be an
ancestor of the current remote default commit. Cleanup preserves:

- Dirty, detached, locked, missing, and non-canonical worktrees.
- Paths with an open file or working directory held by this user's processes.
- Unfinished Git operations and ignored local files, except regenerable
  `node_modules` directories.
- Unmerged and squash-merged heads that lack Git ancestry proof.
- Branches with an existing upstream and conventional long-lived branches
  (`main`, `master`, `develop`, `dev`, `production`, `staging`, `release/*`).

A candidate must have the same HEAD at two eligible observations at least seven
days apart. Cleanup refreshes the remote, Git state, locks, and process activity
again before removal. It uses `git worktree remove` and `git branch -d` without
force. Branches checked out anywhere and the remote default branch stay; after
a worktree is removed, its branch begins its own grace period. This is an
observed grace period, not a record of all activity between runs. Use
`git worktree lock <path>` to retain a worktree deliberately.

Cache cleanup removes files older than 30 days from Xcode DerivedData,
simulator caches, Gradle build caches and Go build caches; older simulator,
Gradle and diagnostic logs; unavailable simulators; unreferenced pnpm store
entries; and Docker build cache older than seven days when Docker is running.
Xcode Archives, stopped containers, images, volumes, project sources, and npm
caches are preserved. Shared Homebrew cleanup remains with its prefix owner.

State lives in owner-only `~/.local/state/dotfiles/hygiene.json`. Runs share
`hygiene.lock` and report outcomes through the update log and existing failure
notifications. An interrupted run leaves its lock for inspection; verify no
cleanup process remains before removing that empty directory. The existing
weekly devbox LaunchAgent invokes the same locked, weekly-gated entrypoint,
so it does not repeat a completed cleanup.

## Notifications And Logs

- Topgrade requests native macOS notifications on failure only; delivery
  depends on the user's notification permissions and Focus settings.
- Successful and unchanged runs stay silent. Their per-step summaries remain
  in `~/Library/Logs/dotfiles/software-update.log`.
- The private local log appends across runs. Archive or truncate it while the
  updater is idle; the scheduler does not rotate it.
- Use `maintenance:status` to check whether the job ran. Failure notifications
  do not detect a scheduler that never started.

The update wrapper preserves the command's exit code, including failed updates.
Failure-only notifications are a native
[Topgrade setting](https://github.com/topgrade-rs/topgrade/blob/v17.9.0/config.example.toml).

Each enrolled job writes a private receipt under
`~/.local/state/dotfiles/updates/<job>.json`, recording start, finish, exit code,
and heartbeat delivery. `maintenance:status` includes the GUI updater receipt.
A receipt left in `running` state is not proof that the process is still alive;
compare it with launchd. The wrapper records no command output or secret URLs.

For an always-on host, an external heartbeat monitor can detect missed or stuck
runs independently of launchd. Provision an owner-only regular file at
`~/.config/dotfiles/update-heartbeats.json` with the required job destinations:

```json
{
  "software-update": "https://monitor.example/software-heartbeat",
  "homebrew-update": "https://monitor.example/homebrew-heartbeat"
}
```

Each URL must accept GET for success and GET at its `/fail` suffix for failure.
The wrapper sends only the result, after the entire command finishes. Requests
time out after 15 seconds and do not follow redirects. Delivery failures remain
visible in the receipt and log without changing the update result or repeating
package operations. Missing configuration disables external reporting; invalid
configuration records a delivery failure while updates continue.

Provision monitors and secret URLs through the owning host infrastructure.
For six-hour jobs, allow a grace period for update duration and scheduling
jitter. Do not enroll an intermittently used laptop as an always-on heartbeat;
normal sleep or power-off would cause false incidents. Native notifications
and on-demand status remain available there. Reload existing jobs after this
wrapper changes their plist arguments, using the recovery procedure below.

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

## Headless Devbox Updates

Prepare each user's persistent dotfiles checkout and dependencies, then apply
its `personal-devbox` or `devbox` Topgrade config. Install Topgrade once through
the prefix owner's `brew-devbox.ts install topgrade` command if needed.

As an administrator, enroll the prefix owner with both jobs:

```sh
sudo node scripts/bootstrap/install-devbox-service-daemons.ts \
  --user example --software-updates --homebrew-updates \
  --updates-repository /Users/example/projects/dotfiles
```

For each other devbox user, omit `--homebrew-updates` and select that user's own
checkout. The installer requires the selected user to own the checkout and
profile files; only the Homebrew prefix owner can enroll the shared package job.
Use the [SOPS-backed sudo helper](devbox.md#sudo-without-a-plaintext-password-file)
when that is the host's established administrator path.

| Job, under the stored launchd namespace | Command and timing |
| --- | --- |
| `local.dotfiles.homebrew-update.<user>` | `brew-devbox.ts --update-software`: refresh metadata, then upgrade unpinned formulae and greedy casks at 00:23, 06:23, 12:23, and 18:23 |
| `local.dotfiles.software-update.<user>` | Per-user Topgrade, limited to GitHub CLI extensions and dotfiles convergence; same hours at minute `33 + (uid % 20)` |

Both jobs run once on enrollment and at boot, so boot runs can overlap across
users. Each label has one instance. Jobs run with the selected user's home,
PATH, and existing credentials; they contain no service tokens and supply no
sudo password. Dotfiles source and declared runtime changes converge under the
selected user; OS updates and reboots stay outside their scope. Re-enrollment retains matching loaded jobs without restarting them.

The installer refuses enrollment while that user's GUI updater is loaded, then
disables its GUI label across logins. `maintenance:enable` refuses to create a
GUI duplicate while the system plist exists.

Inspect or request a run with the actual installed label:

```sh
launchctl print system/local.dotfiles.software-update.example
sudo launchctl kickstart system/local.dotfiles.software-update.example
sudo launchctl kickstart system/local.dotfiles.homebrew-update.example
tail -n 80 ~/Library/Logs/dotfiles/software-update.log
tail -n 80 ~/Library/Logs/dotfiles/homebrew-update.log
```

Use `kickstart` without `-k` to preserve an active run. A request acknowledges
launching, not completion; check the job's state, last exit code, and log.
Headless jobs use private local logs, receipts, and launchd exit status. Desktop
notifications are disabled. External delivery uses the optional per-user
heartbeat file above; this command does not provision monitors or secret URLs.

Add `--check` to the enrollment command to compare installed plist content,
root:wheel ownership, mode `0644`, and loaded state without changing them.
To reload changed settings, wait for idle, then disable and bootout each affected
label before rerunning enrollment:

```sh
sudo launchctl disable system/local.dotfiles.software-update.example
sudo launchctl bootout system/local.dotfiles.software-update.example
```

Disabling persists across boots; bootout stops any active run. Leave the job
disabled to pause updates. To return to a GUI updater, also remove its system
plist before running `maintenance:enable` as the GUI user.

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
