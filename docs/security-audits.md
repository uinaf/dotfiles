# Security Audits

Security audits in this repo are check-only by default. They should make drift
visible without printing secret values or applying remediation.

## Audit Layers

Use separate checks for separate risk surfaces:

| Layer | Tooling | Purpose |
| --- | --- | --- |
| Repository content | `gitleaks`, `trufflehog`, `.github/workflows/secrets.yml` | Detect committed or proposed secrets. |
| macOS posture | macOS Security Compliance Project through `scripts/security/audit.sh` | Check host security settings against a generated baseline. |
| Personal drift | `scripts/security/audit-personal.sh` | Check non-devbox user secret boundaries, identity state, and local stale files. |
| Devbox drift | `scripts/devbox/security-audit.sh` | Check agent-machine secret boundaries, identity state, and local stale files. |
| Functional bootstrap | `scripts/bootstrap/verify.sh`, `scripts/devbox/verify.sh` | Confirm tools and expected services work. |

Do not treat one layer as a substitute for another. For example, a clean
Gitleaks run does not prove launchd or process-compose state is safe.

## Repository Secret Scanning

Run locally before committing security-sensitive setup changes:

```zsh
./scripts/bootstrap/verify-repo.sh
```

That command runs the repository secret scan through
`./scripts/security/audit.sh --skip-mscp` after the normal shell, workflow, and
diff checks. Run `./scripts/security/audit.sh --skip-mscp` directly when you
only need the secret scanners.

For agent or dashboard consumption, add `--json`:

```zsh
./scripts/security/audit.sh --skip-mscp --json
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

## macOS Security Compliance Project

`scripts/security/audit.sh` can run an existing mSCP compliance script in
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
./scripts/security/audit.sh --allow-sudo-prompt
```

Review non-compliant rules and decide exceptions before applying remediation.
Do not blindly apply a federal or STIG-style baseline to personal Macs or
shared devboxes.

## Personal Drift Audit

Run this from a normal personal Mac user:

```zsh
./scripts/security/audit-personal.sh
```

Use `./scripts/security/audit-personal.sh --json` when an agent needs a compact
status summary.

It checks:

- default shells do not export `OP_SERVICE_ACCOUNT_TOKEN`
- devbox-only token and generated env paths are absent for the current user
- local Git, SSH, and Codex config files are owner-only where expected
- Gitleaks does not report leaks in shell startup, shell history, SSH config,
  common credential files, Docker config, or LaunchAgents
- 1Password item references in those local files are surfaced as warnings
- Git identity, GitHub auth, signing key, and commit-signing state are visible
- SSH private key files are not group/world-readable
- admin group membership, when `UINAF_EXPECTED_ADMIN_USERS` is configured
- Tailscale CLI status works when installed

Warnings are normal when a personal Mac intentionally does not enforce signing
or admin membership. Failures mean raw secrets, unsafe file permissions, missing
GitHub auth, or devbox-only service-account state leaked into the personal
setup.

## Devbox Drift Audit

Run this from each devbox user:

```zsh
./scripts/devbox/security-audit.sh
```

Use `./scripts/devbox/security-audit.sh --json` when collecting per-user devbox
audit summaries over SSH.

It checks:

- default shells do not export `OP_SERVICE_ACCOUNT_TOKEN`
- root-owned token file mode and owner when visible
- generated OpenClaw env file mode, owner, and symlink target
- generated env does not contain `OP_SERVICE_ACCOUNT_TOKEN`
- process-compose is isolated through the configured socket or port
- local service config, backup files, and shell history do not contain obvious
  secret references
- Gitleaks does not report leaks in shell startup backups, Git config backups,
  SSH config backups, process-compose backups, OpenClaw rollback files, common
  credential files, Docker config, LaunchAgents, or uinaf LaunchDaemons
- Codex trusted project paths do not cross into another Unix user's home, point
  at missing paths, or trust broad home-root directories
- the home root does not contain stray project artifacts such as `node_modules`
  or lockfiles
- Git identity, GitHub auth, and commit signing are configured
- GitHub SSH auth works for `git@github.com`
- SSH private key files are not group/world-readable
- admin group membership, when `UINAF_EXPECTED_ADMIN_USERS` is configured
- Tailscale CLI status works

The script is intentionally conservative. Warnings mean the auditor should
inspect the machine; failures mean the setup violates the expected boundary.

## Maintenance Rules

- Keep audit scripts non-destructive by default.
- Do not print secret values, token contents, full env dumps, or raw launchd
  environment output.
- Add new checks when a real incident, migration, or setup decision introduces a
  repeatable drift risk.
- Update this document whenever audit scripts, CI scan behavior, or devbox
  secret boundaries change.
- Keep local machine names, vault item names, and private identity context out
  of public examples.
