# Security Audits

Security audits in this repo are check-only by default. They should make drift
visible without printing secret values or applying remediation.

## Audit Layers

Use separate checks for separate risk surfaces:

| Layer | Tooling | Purpose |
| --- | --- | --- |
| Repository content | `gitleaks`, `trufflehog`, `.github/workflows/secrets.yml` | Detect committed or proposed secrets. |
| Host hardening | `lynis`, `scripts/audit/host.sh` | Run a maintained Unix/macOS host audit without adopting enterprise management. |
| macOS compliance baseline | macOS Security Compliance Project through `scripts/audit/repo.sh` | Check host security settings against a generated baseline. |
| Personal drift | `scripts/audit/personal.sh` | Check non-devbox user secret boundaries, identity state, and local stale files. |
| Devbox drift | `scripts/audit/devbox.sh` | Check agent-machine secret boundaries, identity state, and local stale files. |
| Functional bootstrap | `scripts/verify/bootstrap.sh`, `scripts/verify/devbox-services.sh` | Confirm tools and expected services work. |

Do not treat one layer as a substitute for another. For example, a clean
Gitleaks run does not prove launchd or process-compose state is safe.

## Repository Secret Scanning

Run locally before committing security-sensitive setup changes:

```zsh
./scripts/verify/repo.sh
```

That command runs the repository secret scan through
`./scripts/audit/repo.sh --skip-mscp` after the normal shell, workflow, and
diff checks. Run `./scripts/audit/repo.sh --skip-mscp` directly when you
only need the secret scanners.

For agent or dashboard consumption, add `--json`:

```zsh
./scripts/audit/repo.sh --skip-mscp --json
```

JSON summaries use `status=pass` only when there are no failures or warnings,
`status=warn` when checks completed with warnings, and `status=fail` when any
check failed.

GitHub Actions also runs Gitleaks and TruffleHog on pushes to `main`, pull
requests, weekly schedule, and manual dispatch through
`.github/workflows/secrets.yml`.
The separate Verify workflow skips scanner work in CI and leaves that surface
to the dedicated Secret scanning workflow. See
[GitHub pipelines](github-pipelines.md) for the workflow split.

If either scanner reports a real secret:

1. Treat the secret as exposed.
2. Rotate or revoke it in the owning system.
3. Remove the secret from the repo and commit history when needed.
4. Document only the affected surface and rotation outcome, not the secret.

## Host Hardening Audit

Use Lynis for broad host checks that should not live as custom repo shell
logic:

```zsh
./scripts/audit/host.sh
```

Use `./scripts/audit/host.sh --json` when an agent needs a compact
summary. The default run does not prompt for sudo, so it is safe for routine
personal and devbox checks. For a deeper local audit:

```zsh
./scripts/audit/host.sh --allow-sudo-prompt
```

The script captures Lynis output in a temporary owner-only directory, summarizes
the hardening index, warning count, and suggestion count, then deletes the full
report. Use `--keep-artifacts DIR` only for manual review; Lynis reports can
contain hostnames, local paths, package inventory, and network details.

Treat Lynis as a discovery tool, not a policy engine. Review warnings and
suggestions, decide what fits a personal or shared devbox setup, then encode
only durable repo-specific drift checks in `scripts/audit/personal.sh` or
`scripts/audit/devbox.sh`.

## macOS Security Compliance Project

`scripts/audit/repo.sh` can run an existing mSCP compliance script in
check-only mode. It never runs `--fix`.

Prepare mSCP outside this repo:

```zsh
mkdir -p ~/projects/security
cd ~/projects/security
git clone https://github.com/usnistgov/macos_security.git
cd macos_security
git checkout sequoia
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
./scripts/generate_baseline.py -k 800-53r5_moderate
./scripts/generate_guidance.py -s baselines/800-53r5_moderate.yaml
```

Use the branch matching the host macOS version, such as `sequoia`, `sonoma`, or
`ventura`. Then run:

```zsh
./scripts/audit/repo.sh --allow-sudo-prompt
```

Review non-compliant rules and decide exceptions before applying remediation.
Do not blindly apply a federal or STIG-style baseline to personal Macs or
shared devboxes.

## Personal Drift Audit

Run this from a normal personal Mac user:

```zsh
./scripts/audit/personal.sh
```

Use `./scripts/audit/personal.sh --json` when an agent needs a compact
status summary.

It checks:

- default shells do not export `OP_SERVICE_ACCOUNT_TOKEN`
- devbox-only token and generated env paths are absent for the current user
- local Git, SSH, and Codex config files are owner-only where expected
- Gitleaks and TruffleHog do not report leaks in shell startup, shell history,
  SSH config, common credential files, Docker config, or LaunchAgents
- 1Password item references in those local files are surfaced as warnings
- Git identity, GitHub auth, signing key, and commit-signing state are visible
- broad GitHub CLI token scopes such as `workflow` are surfaced as warnings
- SSH private key files are not group/world-readable
- Codex log databases are surfaced when they grow beyond local privacy and disk
  budget thresholds
- admin group membership, when `UINAF_EXPECTED_ADMIN_USERS` is configured
- Tailscale CLI status works when installed

Warnings are normal when a personal Mac intentionally does not enforce signing
or admin membership. Failures mean raw secrets, unsafe file permissions, missing
GitHub auth, or devbox-only service-account state leaked into the personal
setup.

## Devbox Drift Audit

Run this from each devbox user:

```zsh
./scripts/audit/devbox.sh
```

Use `./scripts/audit/devbox.sh --json` when collecting per-user devbox
audit summaries over SSH.

It checks:

- default shells do not export `OP_SERVICE_ACCOUNT_TOKEN`
- root-owned token file mode and owner when visible
- generated OpenClaw env file mode, owner, and symlink target
- generated env does not contain `OP_SERVICE_ACCOUNT_TOKEN`
- process-compose is isolated through the configured socket or port
- local service config, backup files, and shell history do not contain obvious
  secret references
- Gitleaks and TruffleHog do not report leaks in shell startup backups, Git
  config backups, SSH config backups, process-compose backups, OpenClaw
  rollback files, common credential files, Docker config, LaunchAgents, or
  uinaf LaunchDaemons
- OpenClaw runtime credential stores are not part of the default Gitleaks pass;
  this audit checks their surrounding boundaries without dumping or scanning
  expected auth state.
- Codex trusted project paths do not cross into another Unix user's home, point
  at missing paths, or trust broad home-root directories
- the home root does not contain stray project artifacts such as `node_modules`
  or lockfiles
- project directories under `~/projects` are not readable by other local users
- Git identity, GitHub auth, and commit signing are configured
- broad GitHub CLI token scopes such as `delete_repo` and `workflow` are
  surfaced as warnings
- GitHub SSH auth works for `git@github.com`
- SSH private key files are not group/world-readable
- screen-sharing and remote-Apple-event group membership is surfaced as a
  warning
- admin group membership, when `UINAF_EXPECTED_ADMIN_USERS` is configured
- Tailscale CLI status works

The script is intentionally conservative. Warnings mean the auditor should
inspect the machine; failures mean the setup violates the expected boundary.

## Maintenance Rules

- Keep audit scripts non-destructive by default.
- Do not print secret values, token contents, full env dumps, or raw launchd
  environment output.
- Prefer maintained scanners such as Lynis, Gitleaks, TruffleHog, and mSCP for
  generic detection. Add custom shell checks only for repo-specific boundaries
  that those tools cannot understand.
- Add new custom checks when a real incident, migration, or setup decision
  introduces a repeatable drift risk.
- Update this document whenever audit scripts, CI scan behavior, or devbox
  secret boundaries change.
- Keep local machine names, vault item names, and private identity context out
  of public examples.

## Tool References

- [Lynis documentation](https://cisofy.com/documentation/lynis/) for host
  audit behavior and command options.
- [macOS Security Compliance Project](https://pages.nist.gov/macos_security/)
  for macOS baselines and check-only compliance scripts.
- [Gitleaks](https://gitleaks.org/) and
  [TruffleHog](https://docs.trufflesecurity.com/) for maintained secret
  detection.
