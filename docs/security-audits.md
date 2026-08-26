# Security Audits

Security audits in this repo are check-only by default. They make drift visible
without applying remediation.

Treat local audit stdout and saved logs as sensitive.

- Workstation and devbox local Gitleaks scans write an owner-only temporary
  report outside the staged scan tree.
- Prose mode prints only sanitized locators: `rule` and the staged relative
  `path`.
- Compact `--json` mode exposes aggregate finding counts by rule ID and never
  includes matched secret material.
- Sanitized locators and rule aggregates use the repository's typed Node
  tooling. Without Node the scan still fails closed on a non-zero Gitleaks
  status but omits locators.
- Other maintained scanners can still include matched material in their own
  prose output. Use `--json` for remote collection, and do not paste raw scanner
  output into issues, pull requests, or chat.

Live credential stores are checked against their own boundaries instead of
failing merely because they contain credentials. For example, `~/.npmrc` is
checked for owner-only permissions and registry-scoped auth settings, and is
not passed to the generic local secret scan.

## Audit Layers

Use separate checks for separate risk surfaces:

| Layer | Tooling | Purpose |
| --- | --- | --- |
| Repository content | `gitleaks`, `trufflehog`, `.github/workflows/secrets.yml` | Detect committed or proposed secrets. |
| Host hardening | `lynis`, `mise run audit host` | Run a maintained Unix/macOS host audit without adopting enterprise management. |
| macOS compliance baseline | macOS Security Compliance Project through `mise run audit mscp` | Check host security settings against a generated baseline. |
| Workstation drift | `mise run audit workstation` | Check human workstation secret boundaries, identity state, and local stale files. |
| Devbox drift | `mise run audit devbox` | Check agent-machine secret boundaries, identity state, and local stale files. |
| Functional bootstrap | `scripts/verify/bootstrap.ts`, `scripts/verify/devbox-services.ts` | Confirm tools, the SOPS age identity when the profile consumes secrets, and expected services work. |

Do not treat one layer as a substitute for another. For example, a clean
Gitleaks run does not prove launchd state is safe.

## Repository Secret Scanning

Run locally before committing security-sensitive setup changes:

```zsh
mise run verify
```

That command runs the repository secret scan after the complete deterministic
graph. Run `mise run audit repo` when you only need the secret scanners.

The local Gitleaks scan covers `HEAD`, every local branch, remote-tracking
branch, and tag. Other transient nonstandard refs are outside that
repository-history boundary.

For agent or dashboard consumption, add `--json`:

```zsh
mise run audit repo --format json
```

JSON summaries carry one `status`:

| Value | Meaning |
| --- | --- |
| `status=pass` | No failures and no warnings |
| `status=warn` | Checks completed with warnings |
| `status=fail` | At least one check failed |

## Finding Severity

Local Gitleaks severity policy lives in
`scripts/audit/gitleaks-policy.json`.

| Severity | Audit outcome |
| --- | --- |
| `low`, `medium` | Warn |
| `high`, `critical` | Fail |
| Unknown rule | Treated as `high`, so it fails |

- The `generic-api-key` rule is `low` because it is heuristic and commonly
  matches shell assignment history.
- `.gitleaks.toml` extends the default rules and may allow only exact synthetic
  fixture values; never allowlist a path, commit, provider rule, or real key.
- Findings verified by TruffleHog still fail independently.
- JSON summaries include finding totals grouped by Gitleaks rule and severity.
- The policy changes the audit outcome, not the scanner output or the sanitized
  locators.

## Local Audit Policy

- Shared audit policy lives in `~/.config/dotfiles/audit.env`, installed from
  the tracked `chezmoi/private_dot_config/private_dotfiles/audit.env`.
- Keep it public-safe: accepted scope names and drift thresholds are allowed,
  but never secrets, tokens, 1Password references, or identity-specific values.

GitHub CLI scope checks use this file:

```sh
GH_SENSITIVE_SCOPES="delete_repo workflow admin:org admin:public_key admin:repo_hook write:packages"
GH_ACCEPTED_SCOPES="delete_repo workflow admin:org admin:public_key admin:repo_hook write:packages"
```

- Scopes in `GH_SENSITIVE_SCOPES` are audited centrally.
- A scope also listed in `GH_ACCEPTED_SCOPES` is reported as accepted by policy
  instead of warning.
- Override with `AUDIT_POLICY_FILE=/path/to/file` for local experiments.

GitHub Actions runs Gitleaks and TruffleHog through
`.github/workflows/secrets.yml` on pushes to `main`, pull requests, a weekly
schedule, and manual dispatch. The Verify workflow leaves that surface to the
dedicated Secret scanning workflow; see
[GitHub pipelines](github-pipelines.md) for the split.

If either scanner reports a real secret:

1. Treat the secret as exposed.
2. Rotate or revoke it in the owning system.
3. Remove the secret from the repo and commit history when needed.
4. Document only the detector type, affected surface, and rotation outcome, not
   the secret value.

## Host Hardening Audit

Use Lynis for broad host checks that should not live as custom repo shell
logic:

```zsh
mise run audit host
```

- `mise run audit host --format json` gives an agent a compact summary.
- The default run does not prompt for sudo, so it is safe for routine
  workstation and devbox checks.

For a deeper local audit:

```zsh
node scripts/audit/host.ts --allow-sudo-prompt
```

- The typed adapter captures Lynis output in a temporary owner-only directory,
  summarizes the hardening index, warning count, and suggestion count, then
  deletes the full report.
- Use `--keep-artifacts DIR` only for manual review: Lynis reports can contain
  hostnames, local paths, package inventory, and network details.

Treat Lynis as a discovery tool, not a policy engine. Review warnings and
suggestions, decide what fits a workstation or shared devbox setup, then encode
only durable repo-specific drift checks in `scripts/audit/workstation.ts` or
`scripts/audit/devbox.ts`.

## macOS Security Compliance Project

`mise run audit mscp` can run an existing mSCP compliance script in
check-only mode. It never runs `--fix`.

Prepare mSCP outside this repo:

```zsh
mkdir -p ~/projects/security
cd ~/projects/security
git clone https://github.com/usnistgov/macos_security.git
cd macos_security
uv venv --python 3.13
uv pip install --python .venv/bin/python -r requirements.txt
PATH="$PWD/.venv/bin:$PATH" ./mscp.py --os_name macos --os_version 26 baseline -k 800-53r5_moderate
PATH="$PWD/.venv/bin:$PATH" ./mscp.py --os_name macos --os_version 26 guidance \
  custom/baselines/800-53r5_moderate_macos_26.0.yaml --script --no-docs
```

- Replace `26` with the host's macOS major version.
- mSCP 2.0 uses one `main` branch and writes the generated script under `build/`
  with the platform and major version in its name.
- The audit derives that default path from `sw_vers`; use `--mscp-script` for a
  custom path.
- mSCP remains optional and external, and the bootstrap does not install its
  Python dependencies.
- Its rule model provides control IDs, references, tags, and severity, but the
  generated host checks are still shell.
- Use it for macOS compliance baselines, not as the policy engine for this
  repo's workstation and devbox boundaries.

Then run:

```zsh
node scripts/audit/repo.ts --allow-sudo-prompt
```

Review non-compliant rules and decide exceptions before applying remediation.
Do not blindly apply a federal or STIG-style baseline to workstation Macs or
shared devboxes.

## Workstation Drift Audit

Run this from a normal workstation user:

```zsh
mise run audit workstation
```

- `mise run audit workstation --format json` gives an agent a compact status
  summary.
- Workstation policy is declared in `scripts/audit/workstation.ts` and executed
  by the typed engine in `scripts/audit/engine.ts`.

It checks:

- local Git, SSH, and Codex config files are owner-only where expected
- npm auth settings are registry-scoped and `~/.npmrc` is owner-only
- Gitleaks and TruffleHog do not report leaks in shell startup, shell history,
  SSH config, common credential files, Docker config, or LaunchAgents
- 1Password item references in those local files are surfaced as warnings
- Git identity, GitHub auth, signing key, and commit-signing state are visible
- broad GitHub CLI token scopes are checked against the central local audit
  policy
- SSH private key files are not group/world-readable
- Codex log databases are surfaced when live SQLite data grows beyond local
  privacy and disk budget thresholds; reclaimable freelist space warns instead
  of failing when the physical file is large but live data is modest. Live and
  reclaimable sizes are derived from the SQLite database header (no engine open
  / no VACUUM); if header stats are unavailable the check falls back to
  physical file size. Typed tooling reads the header without opening the engine
- Tailscale CLI status works when installed

Warnings are normal when a workstation intentionally keeps optional services or
large local logs. Failures mean raw secrets, unsafe file permissions, or missing
GitHub auth.

## Devbox Drift Audit

Run this from each devbox user:

```zsh
mise run audit devbox
```

Use `mise run audit devbox --format json` when collecting per-user devbox
audit summaries over SSH. The devbox policy uses the same typed engine as the
workstation audit.

It checks:

- local service config, backup files, and shell history do not contain obvious
  secret references
- npm auth settings are registry-scoped and `~/.npmrc` is owner-only
- Gitleaks and TruffleHog do not report leaks in shell startup backups, Git
  config backups, SSH config backups, workspace env backups, common credential
  files, Docker config, LaunchAgents, or managed LaunchDaemons
- application credential, device, identity, and plugin-runtime stores are
  excluded from the default local secret scan when they are known runtime
  stores; backups and rollback files are scanned because they are common
  stale-secret locations.
- Codex trusted project paths do not cross into another Unix user's home, point
  at missing paths, or trust broad home-root directories
- the home root does not contain stray project artifacts such as `node_modules`
  or lockfiles
- project directories under `~/projects` are not readable by other local users
- Git identity, GitHub auth, and commit signing are configured
- broad GitHub CLI token scopes are checked against the central local audit
  policy
- GitHub SSH auth works for `git@github.com`
- SSH private key files are not group/world-readable
- Tailscale CLI status works

The script is intentionally conservative. Warnings mean the auditor should
inspect the machine; failures mean the setup violates the expected boundary.

## Maintenance Rules

- Keep audit scripts non-destructive by default.
- Do not add custom output that prints secret values, token contents, full env
  dumps, or raw launchd environment output. When a maintained scanner includes
  matched secret material in a finding, treat that output as sensitive and use
  JSON summaries or manual summaries for reporting.
- Prefer maintained scanners such as Lynis, Gitleaks, TruffleHog, and mSCP for
  generic detection. Add custom shell checks only for repo-specific boundaries
  that those tools cannot understand.
- Check live credential stores for unsafe permissions or structure. Do not
  report the expected presence of a credential as a leak.
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
- [npmrc](https://docs.npmjs.com/cli/v12/configuring-npm/npmrc/) for npm auth
  storage and registry scoping.
