# Security Audits

Audits report findings without applying remediation. Prepare tooling with
`./dotfiles prepare`; run host checks as the user being audited.

## Run an Audit

| Command | Scope |
| --- | --- |
| `mise run verify` | Deterministic repository checks and secret scans |
| `mise run audit repo` | Repository Gitleaks and TruffleHog scans |
| `mise run audit workstation` | Local credentials, file permissions, identity, and workstation drift |
| `mise run audit devbox` | Per-user devbox credentials, Codex privacy/trust, Git/SSH, and project-directory permissions |
| `mise run audit host` | Lynis host hardening; no sudo prompt by default |
| `mise run audit mscp` | External mSCP baseline plus repository secret scans |

- Use `--format json` for collection, for example
  `mise run audit devbox --format json`. Direct scripts accept `--json`.
- JSON status: `pass` means no warnings/failures; `warn` means warnings only;
  `fail` means at least one failed check.
- Treat scanner output and retained reports as sensitive. Local Gitleaks reports
  sanitized locators/counts; other scanners may print matched secrets. Share
  JSON summaries, not raw output.

## Interpret Findings

- [Gitleaks policy](../scripts/audit/gitleaks-policy.json): low/medium warn;
  high/critical and unknown rules fail. Verified TruffleHog findings fail
  independently.
- [`generic-api-key`](../scripts/audit/gitleaks-policy.json) is low severity
  because it frequently matches shell assignments. Inspect it before dismissing it.
- [Gitleaks allowlists](../.gitleaks.toml) may contain exact synthetic fixture
  values only; never real keys, whole paths, commits, or provider rules.
- Live credential stores receive permission/structure checks. For example,
  `~/.npmrc` must be owner-only with registry-scoped auth; the generic scan
  excludes it. Backups remain scan targets.
- Inspect the owning [workstation](../scripts/audit/workstation.ts) or
  [devbox](../scripts/audit/devbox.ts) policy for individual checks. Devbox project
  privacy checks cover `~/projects` and `~/projects/<devbox-user>`, not every
  descendant. Codex log-size warnings distinguish live data from reclaimable
  space where database headers are readable.

For a real secret:

1. Rotate or revoke it in the owning system.
2. Remove it from the repository and history when needed.
3. Record detector, affected surface, and rotation outcome without the value.

## Repository and Scope Policy

- Local Gitleaks scans `HEAD`, branches, remote-tracking branches, and tags.
  Nonstandard transient refs are excluded.
- [CI scanning](../.github/workflows/secrets.yml) runs on pull requests, weekly,
  and manual dispatch.
- `~/.config/dotfiles/audit.env` configures accepted GitHub scopes and drift
  thresholds. Keep it public-safe; no credentials or identity-specific values.
- Scopes in `GH_SENSITIVE_SCOPES` warn unless also in `GH_ACCEPTED_SCOPES`.
  Use `AUDIT_POLICY_FILE=/path/to/file` for a local override.

## Deeper Host Checks

```zsh
node scripts/audit/host.ts --allow-sudo-prompt
```

- Lynis reports are temporary and deleted after summarizing.
- Use `--keep-artifacts DIR` for manual review only: reports include hostnames,
  paths, packages, and network details.

mSCP is optional and installed outside this repository. Prepare its baseline:

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

- Replace `26` with the host's macOS major version; return to the dotfiles
  checkout before running its audit commands.
- The audit derives the generated `build/` script path from `sw_vers`.
  Pass `--mscp-script PATH` to [repo.ts](../scripts/audit/repo.ts) for a custom path.
- `node scripts/audit/repo.ts --allow-sudo-prompt` permits privileged checks.
  The adapter never runs `--fix`; review exceptions before applying remediation.
- References: [Lynis](https://cisofy.com/documentation/lynis/),
  [mSCP](https://pages.nist.gov/macos_security/).
