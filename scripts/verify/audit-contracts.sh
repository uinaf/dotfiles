#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp_root="$(mktemp -d)"
trap 'rm -rf "$tmp_root"' EXIT

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

HOME="$tmp_root/home"
mkdir -p "$HOME/.ssh/nested"
export json_output=1
export warn_count=0
export fail_count=0
export secret_scan_count=0
export secret_scan_finding_count=0
export secret_scan_rules_json=

# shellcheck source=scripts/lib/audit.sh
. "$repo_root/scripts/lib/audit.sh"

printf 'ssh-ed25519 fixture authorized\n' > "$HOME/.ssh/authorized_keys"
chmod 0644 "$HOME/.ssh/authorized_keys"
printf '\n-----BEGIN OPENSSH PRIVATE KEY-----\n' > "$HOME/.ssh/nested/id_ed25519"
chmod 0644 "$HOME/.ssh/nested/id_ed25519"
check_ssh_private_key_modes
[ "$fail_count" -eq 1 ] || fail "nested private key mode was not rejected exactly once"

fail_count=0
printf '%s\n' '---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----' > "$HOME/.ssh/nested/id_ssh2"
printf '%s\n' 'PuTTY-User-Key-File-3: ssh-ed25519' > "$HOME/.ssh/nested/id_putty"
chmod 0600 "$HOME/.ssh/nested/id_ed25519" "$HOME/.ssh/nested/id_ssh2" "$HOME/.ssh/nested/id_putty"
check_ssh_private_key_modes
[ "$fail_count" -eq 0 ] || fail "owner-only private keys or authorized_keys were misclassified"

workstation_json="$(DOTFILES_AUDIT_NAME=workstation-security HOME="$HOME" SHELL=/bin/sh "$repo_root/scripts/audit/workstation.sh" --json 2>/dev/null || true)"
printf '%s\n' "$workstation_json" | grep -Fq '"audit":"workstation-security"' \
  || fail "workstation JSON audit name changed"
if printf '%s\n' "$workstation_json" | grep -Fq '"user":'; then
  fail "workstation JSON exposed the Unix user"
fi

personal_json="$(HOME="$HOME" SHELL=/bin/sh "$repo_root/scripts/audit/personal.sh" --json 2>/dev/null || true)"
printf '%s\n' "$personal_json" | grep -Fq '"audit":"personal-security"' \
  || fail "personal compatibility audit name changed"

personal_task_json="$(cd "$repo_root" && HOME="$HOME" SHELL=/bin/sh ./.mise/tasks/audit/personal/json 2>/dev/null || true)"
printf '%s\n' "$personal_task_json" | grep -Fq '"audit":"personal-security"' \
  || fail "personal compatibility task bypassed the personal audit wrapper"

grep -Fqx './scripts/audit/personal.sh' "$repo_root/.mise/tasks/audit/personal/_default" \
  || fail "personal default task bypassed the personal audit wrapper"

command -v gitleaks >/dev/null 2>&1 \
  || fail "gitleaks required for audit contract secret-scan tests"
command -v python3 >/dev/null 2>&1 \
  || fail "python3 required for audit contract secret-scan tests"
command -v trufflehog >/dev/null 2>&1 \
  || fail "trufflehog required for audit contract secret-scan tests"

secret_fixture="$tmp_root/secret-home"
mkdir -p "$secret_fixture"
cat >"$secret_fixture/id_rsa" <<'EOF'
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF6PZGBlewn0LqYSdzaWQmJeJrQHL
-----END RSA PRIVATE KEY-----
EOF
cat >"$secret_fixture/id_ed25519" <<'EOF'
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
-----END OPENSSH PRIVATE KEY-----
EOF
chmod 600 "$secret_fixture/id_rsa" "$secret_fixture/id_ed25519"

prose_log="$tmp_root/prose-secret-scan.log"
json_output=0
warn_count=0
fail_count=0
secret_scan_count=0
secret_scan_finding_count=0
secret_scan_rules_json=
# Avoid command substitution: scan_files_for_secrets mutates counters in-process.
set +e
HOME="$secret_fixture" \
  scan_files_for_secrets < <(printf '%s\n' "$secret_fixture/id_rsa" "$secret_fixture/id_ed25519") \
  >"$prose_log" 2>&1
set -e
prose_output="$(cat "$prose_log")"
[ "$fail_count" -ge 1 ] || fail "fixture with leaks did not fail the local secret scan"
printf '%s\n' "$prose_output" | grep -Eq 'finding rule=private-key path=home/id_' \
  || fail "prose mode did not emit sanitized rule/path locators"
# Gitleaks prose used to stream Finding/Secret blocks; those must stay gone.
if printf '%s\n' "$prose_output" | grep -Eq '^Finding:|^Secret:|^Fingerprint:'; then
  fail "prose mode still streamed raw gitleaks finding blocks"
fi
finding_lines="$(printf '%s\n' "$prose_output" | grep '^finding rule=' || true)"
if printf '%s\n' "$finding_lines" | grep -Eq 'BEGIN (RSA|OPENSSH) PRIVATE KEY|MIIEowIBAAKCAQEA|b3BlbnNzaC1rZXktdjE'; then
  fail "sanitized finding lines leaked secret material"
fi
[ "$secret_scan_finding_count" -ge 1 ] || fail "finding count was not recorded"
printf '%s\n' "$secret_scan_rules_json" | grep -Fq '"private-key"' \
  || fail "rule aggregates omitted private-key"

json_output=1
warn_count=0
fail_count=0
secret_scan_count=0
secret_scan_finding_count=0
secret_scan_rules_json=
HOME="$secret_fixture" \
  scan_files_for_secrets < <(printf '%s\n' "$secret_fixture/id_rsa") >/dev/null 2>&1 || true
[ "$fail_count" -ge 1 ] || fail "json mode did not fail when gitleaks found leaks"
[ "$secret_scan_finding_count" -ge 1 ] || fail "json mode did not count findings"
printf '%s\n' "$secret_scan_rules_json" | grep -Fq '"private-key"' \
  || fail "json mode omitted rule aggregates"
if printf '%s\n' "$secret_scan_rules_json" | grep -Eq 'BEGIN|MIIEowIBAAKCAQEA|Match|Secret'; then
  fail "json rule aggregates included secret material"
fi

# shellcheck disable=SC3043
eval "$(sed -n '/^print_json_summary()/,/^}/p' "$repo_root/scripts/audit/workstation.sh")"
workstation_summary="$(
  fail_count=1
  warn_count=0
  secret_scan_count=2
  secret_scan_finding_count=2
  secret_scan_rules_json='{"private-key":2}'
  print_json_summary
)"
printf '%s' "$workstation_summary" | python3 -c '
import json, sys
data = json.load(sys.stdin)
assert data["secret_scan_finding_count"] == 2
assert data["secret_scan_rules"]["private-key"] == 2
' || fail "workstation --json summary is not valid JSON with rule aggregates"
empty_summary="$(
  fail_count=0
  warn_count=0
  secret_scan_count=0
  secret_scan_finding_count=0
  secret_scan_rules_json=
  print_json_summary
)"
printf '%s' "$empty_summary" | python3 -c '
import json, sys
data = json.load(sys.stdin)
assert data["secret_scan_rules"] == {}
assert data["secret_scan_finding_count"] == 0
' || fail "workstation --json summary default rules object is invalid"

grep -Fq 'secret_scan_finding_count' "$repo_root/scripts/audit/devbox.sh" \
  || fail "devbox JSON summary missing secret_scan_finding_count"
grep -Fq 'secret_scan_rules_json_or_empty_object' "$repo_root/scripts/audit/devbox.sh" \
  || fail "devbox JSON summary missing brace-safe rules helper"

before_scan_dirs="$(find "${TMPDIR:-/tmp}" -maxdepth 1 \( -name 'dotfiles-secret-scan.*' -o -name 'dotfiles-secret-report.*' \) 2>/dev/null | wc -l | tr -d ' ')"

broken_gitleaks_bin="$tmp_root/broken-bin"
broken_gitleaks_log="$tmp_root/broken-gitleaks.log"
mkdir -p "$broken_gitleaks_bin"
cat >"$broken_gitleaks_bin/gitleaks" <<'EOF'
#!/usr/bin/env bash
exit 42
EOF
chmod 755 "$broken_gitleaks_bin/gitleaks"
# Keep trufflehog from also failing so this asserts the gitleaks-error path.
cat >"$broken_gitleaks_bin/trufflehog" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod 755 "$broken_gitleaks_bin/trufflehog"
json_output=0
warn_count=0
fail_count=0
secret_scan_count=0
secret_scan_finding_count=0
secret_scan_rules_json=
PATH="$broken_gitleaks_bin:$PATH" \
  HOME="$secret_fixture" \
  scan_files_for_secrets < <(printf '%s\n' "$secret_fixture/id_rsa") \
  >"$broken_gitleaks_log" 2>&1 || true
[ "$fail_count" -ge 1 ] || fail "gitleaks scanner failure was reported as clean"
[ "$secret_scan_finding_count" -eq 0 ] \
  || fail "gitleaks scanner failure unexpectedly counted findings"
grep -Fq 'gitleaks local config scan failed' "$broken_gitleaks_log" \
  || fail "gitleaks scanner failure did not emit the status-only failure"

missing_python_bin="$tmp_root/missing-python-bin"
missing_python_log="$tmp_root/missing-python.log"
mkdir -p "$missing_python_bin"
ln -s "$(command -v gitleaks)" "$missing_python_bin/gitleaks"
ln -s "$(command -v trufflehog)" "$missing_python_bin/trufflehog"
# Shadow every python3 on PATH while keeping system utilities available.
cat >"$missing_python_bin/python3" <<'EOF'
#!/usr/bin/env bash
exit 127
EOF
chmod 755 "$missing_python_bin/python3"
json_output=0
warn_count=0
fail_count=0
secret_scan_count=0
secret_scan_finding_count=0
secret_scan_rules_json=
PATH="$missing_python_bin:/usr/bin:/bin" \
  HOME="$secret_fixture" \
  scan_files_for_secrets < <(printf '%s\n' "$secret_fixture/id_rsa") \
  >"$missing_python_log" 2>&1 || true
[ "$fail_count" -ge 1 ] || fail "python3-absent degrade path did not fail closed"
[ "$secret_scan_finding_count" -eq 0 ] \
  || fail "python3-absent degrade path counted findings"
if grep -Fq 'finding rule=' "$missing_python_log"; then
  fail "python3-absent degrade path still emitted locators"
fi
grep -Fq 'python3 failed while' "$missing_python_log" \
  || grep -Fq 'python3 is missing' "$missing_python_log" \
  || fail "python3-absent degrade path did not warn"

clean_fixture="$tmp_root/clean-home"
clean_log="$tmp_root/clean-secret-scan.log"
mkdir -p "$clean_fixture"
printf 'export EDITOR=vim\n' >"$clean_fixture/.zshrc"
chmod 644 "$clean_fixture/.zshrc"
json_output=0
warn_count=0
fail_count=0
secret_scan_count=0
secret_scan_finding_count=0
secret_scan_rules_json=
set +e
HOME="$clean_fixture" \
  scan_files_for_secrets < <(printf '%s\n' "$clean_fixture/.zshrc") \
  >"$clean_log" 2>&1
set -e
clean_output="$(cat "$clean_log")"
[ "$fail_count" -eq 0 ] || fail "clean fixture failed the local secret scan"
[ "$secret_scan_finding_count" -eq 0 ] || fail "clean fixture recorded findings"
printf '%s\n' "$clean_output" | grep -Fq 'gitleaks found no leaks' \
  || fail "clean fixture did not report a quiet gitleaks pass"
if printf '%s\n' "$clean_output" | grep -Fq 'finding rule='; then
  fail "clean fixture emitted finding locators"
fi

after_scan_dirs="$(find "${TMPDIR:-/tmp}" -maxdepth 1 \( -name 'dotfiles-secret-scan.*' -o -name 'dotfiles-secret-report.*' \) 2>/dev/null | wc -l | tr -d ' ')"
[ "$after_scan_dirs" -le "$before_scan_dirs" ] \
  || fail "secret-scan temporary directories were left behind"

printf 'ok audit output privacy and recursive SSH private-key classification\n'
