#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp_root="$(mktemp -d)"
mise_global_config="${MISE_GLOBAL_CONFIG_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/mise/config.toml}"
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
# Assemble markers from fragments so the tracked script is not itself a key match.
printf -- '\n-----BEGIN %s PRIVATE KEY-----\n' OPENSSH > "$HOME/.ssh/nested/id_ed25519"
chmod 0644 "$HOME/.ssh/nested/id_ed25519"
check_ssh_private_key_modes
[ "$fail_count" -eq 1 ] || fail "nested private key mode was not rejected exactly once"

fail_count=0
printf '%s%s\n' '---- BEGIN SSH2 ENCRYPTED PRIVATE ' 'KEY ----' > "$HOME/.ssh/nested/id_ssh2"
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

personal_task_json="$(
  cd "$repo_root"
  HOME="$HOME" SHELL=/bin/sh MISE_IGNORED_CONFIG_PATHS="$mise_global_config" MISE_TRUSTED_CONFIG_PATHS="$repo_root" \
    mise run audit personal --format json 2>/dev/null || true
)"
printf '%s\n' "$personal_task_json" | grep -Fq '"audit":"personal-security"' \
  || fail "personal compatibility task bypassed the personal audit wrapper"

workstation_summary="$(
  fail_count=1
  warn_count=0
  secret_scan_count=2
  secret_scan_finding_count=2
  secret_scan_rules_json='{"private-key":2}'
  print_audit_json_summary workstation-security
)"
[ "$(printf '%s' "$workstation_summary" | /usr/bin/plutil -extract secret_scan_finding_count raw -o - -)" = 2 ] \
  || fail "workstation --json summary finding count changed"
[ "$(printf '%s' "$workstation_summary" | /usr/bin/plutil -extract secret_scan_rules.private-key raw -o - -)" = 2 ] \
  || fail "workstation --json summary rule aggregate changed"
empty_summary="$(
  fail_count=0
  warn_count=0
  secret_scan_count=0
  secret_scan_finding_count=0
  secret_scan_rules_json=
  print_audit_json_summary workstation-security
)"
[ "$(printf '%s' "$empty_summary" | /usr/bin/plutil -extract secret_scan_finding_count raw -o - -)" = 0 ] \
  || fail "workstation --json summary default finding count changed"
[ "$(printf '%s' "$empty_summary" | /usr/bin/plutil -extract secret_scan_rules json -o - -)" = '{}' ] \
  || fail "workstation --json summary default rules object is invalid"

devbox_summary="$(
  fail_count=1
  warn_count=0
  secret_scan_count=2
  secret_scan_finding_count=2
  secret_scan_rules_json='{"private-key":2}'
  print_audit_json_summary devbox-security fixture fixture
)"
[ "$(printf '%s' "$devbox_summary" | /usr/bin/plutil -extract secret_scan_finding_count raw -o - -)" = 2 ] \
  || fail "devbox --json summary finding count changed"
[ "$(printf '%s' "$devbox_summary" | /usr/bin/plutil -extract secret_scan_rules.private-key raw -o - -)" = 2 ] \
  || fail "devbox --json summary rule aggregate changed"

if ! command -v sqlite3 >/dev/null 2>&1; then
  printf 'ok sqlite Codex log size contracts skipped (sqlite3 unavailable)\n'
else
  sqlite_fixture="$tmp_root/sqlite-logs"
  mkdir -p "$sqlite_fixture"
  sparse_db="$sqlite_fixture/logs_sparse.sqlite"
  heavy_db="$sqlite_fixture/logs_heavy.sqlite"
  wal_mode_db="$sqlite_fixture/logs_wal.sqlite"
  junk_db="$sqlite_fixture/logs_junk.sqlite"
  broken_header_db="$sqlite_fixture/logs_broken_header.sqlite"
  bad_freelist_db="$sqlite_fixture/logs_bad_freelist.sqlite"
  wal_file="$sqlite_fixture/logs_sparse.sqlite-wal"

  # auto_vacuum=NONE keeps deleted pages on the freelist. FULL would shrink the
  # file and make reclaimable-space fixtures flaky across SQLite builds.
  sqlite3 "$sparse_db" <<'SQL'
PRAGMA auto_vacuum=NONE;
PRAGMA page_size=4096;
CREATE TABLE t(x BLOB);
WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 400)
INSERT INTO t SELECT randomblob(3000) FROM c;
DELETE FROM t;
SQL
  sqlite3 "$heavy_db" <<'SQL'
PRAGMA auto_vacuum=NONE;
PRAGMA page_size=4096;
CREATE TABLE t(x BLOB);
WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 400)
INSERT INTO t SELECT randomblob(3000) FROM c;
SQL
  sqlite3 "$wal_mode_db" <<'SQL' >/dev/null
PRAGMA auto_vacuum=NONE;
PRAGMA journal_mode=WAL;
PRAGMA page_size=4096;
CREATE TABLE t(x BLOB);
WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 400)
INSERT INTO t SELECT randomblob(3000) FROM c;
DELETE FROM t;
SQL
  # Remove sidecar files so the probe must work from the DB header alone,
  # without an engine open / shm recovery path.
  rm -f "${wal_mode_db}-wal" "${wal_mode_db}-shm"
  printf 'not a sqlite database\n' >"$junk_db"
  printf 'wal-bytes\n' >"$wal_file"
  cp "$heavy_db" "$broken_header_db"
  printf '\000\000' | dd of="$broken_header_db" bs=1 seek=16 conv=notrunc 2>/dev/null
  cp "$heavy_db" "$bad_freelist_db"
  printf '\377\377\377\377' | dd of="$bad_freelist_db" bs=1 seek=36 conv=notrunc 2>/dev/null
  sparse_cksum_before="$(cksum "$sparse_db")"
  wal_cksum_before="$(cksum "$wal_mode_db")"

  sparse_log="$sqlite_fixture/sparse.log"
  json_output=0
  warn_count=0
  fail_count=0
  CODEX_LOG_FAIL_BYTES=1000000 \
    CODEX_LOG_WARN_BYTES=200000 \
    CODEX_LOG_RECLAIM_WARN_BYTES=200000 \
    CODEX_LOG_FREELIST_WARN_RATIO=40 \
    CODEX_LOG_RECLAIM_FLOOR_BYTES=1000 \
    check_codex_log_file_size "$sparse_db" >"$sparse_log" 2>&1
  [ "$fail_count" -eq 0 ] || fail "sparse SQLite log failed instead of warning"
  grep -Fq 'high reclaimable SQLite space' "$sparse_log" \
    || fail "sparse SQLite log did not warn about reclaimable space"
  [ "$(cksum "$sparse_db")" = "$sparse_cksum_before" ] \
    || fail "SQLite page-stat probe modified the sparse database"

  heavy_log="$sqlite_fixture/heavy.log"
  warn_count=0
  fail_count=0
  CODEX_LOG_FAIL_BYTES=100000 \
    CODEX_LOG_WARN_BYTES=50000 \
    CODEX_LOG_RECLAIM_WARN_BYTES=1000000000 \
    CODEX_LOG_FREELIST_WARN_RATIO=100 \
    check_codex_log_file_size "$heavy_db" >"$heavy_log" 2>&1
  [ "$fail_count" -ge 1 ] || fail "heavy SQLite live data did not fail"
  grep -Fq 'live data is larger than' "$heavy_log" \
    || fail "heavy SQLite log did not fail on live data"

  healthy_log="$sqlite_fixture/healthy.log"
  warn_count=0
  fail_count=0
  CODEX_LOG_FAIL_BYTES=100000000 \
    CODEX_LOG_WARN_BYTES=50000000 \
    CODEX_LOG_RECLAIM_WARN_BYTES=50000000 \
    CODEX_LOG_FREELIST_WARN_RATIO=90 \
    CODEX_LOG_RECLAIM_FLOOR_BYTES=50000000 \
    check_codex_log_file_size "$heavy_db" >"$healthy_log" 2>&1
  [ "$fail_count" -eq 0 ] || fail "healthy SQLite thresholds unexpectedly failed"
  [ "$warn_count" -eq 0 ] || fail "healthy SQLite thresholds unexpectedly warned"
  grep -Fq 'size is healthy' "$healthy_log" \
    || fail "healthy SQLite thresholds did not report ok"

  wal_log="$sqlite_fixture/wal.log"
  warn_count=0
  fail_count=0
  CODEX_LOG_FAIL_BYTES=1000000 \
    CODEX_LOG_WARN_BYTES=200000 \
    CODEX_LOG_RECLAIM_WARN_BYTES=200000 \
    CODEX_LOG_FREELIST_WARN_RATIO=40 \
    CODEX_LOG_RECLAIM_FLOOR_BYTES=1000 \
    check_codex_log_file_size "$wal_mode_db" >"$wal_log" 2>&1
  [ "$fail_count" -eq 0 ] || fail "WAL-mode SQLite log failed instead of warning"
  grep -Fq 'high reclaimable SQLite space' "$wal_log" \
    || fail "WAL-mode SQLite log did not use header-based reclaimable accounting"
  grep -Fq 'SQLite stats unavailable' "$wal_log" \
    && fail "WAL-mode SQLite log fell back to physical size"
  [ "$(cksum "$wal_mode_db")" = "$wal_cksum_before" ] \
    || fail "SQLite page-stat probe modified the WAL-mode database"

  junk_log="$sqlite_fixture/junk.log"
  warn_count=0
  fail_count=0
  CODEX_LOG_FAIL_BYTES=10 \
    CODEX_LOG_WARN_BYTES=5 \
    check_codex_log_file_size "$junk_db" >"$junk_log" 2>&1
  [ "$fail_count" -ge 1 ] || fail "invalid non-SQLite input did not use physical fail"
  grep -Fq 'is larger than' "$junk_log" \
    || fail "invalid non-SQLite input did not report physical-size failure"
  [ "$(cat "$junk_db")" = "not a sqlite database" ] \
    || fail "invalid non-SQLite probe modified the input file"

  broken_log="$sqlite_fixture/broken-header.log"
  warn_count=0
  fail_count=0
  CODEX_LOG_FAIL_BYTES=10 \
    CODEX_LOG_WARN_BYTES=5 \
    check_codex_log_file_size "$broken_header_db" >"$broken_log" 2>&1
  [ "$fail_count" -ge 1 ] || fail "broken SQLite header did not fall back to physical fail"
  grep -Fq 'SQLite stats unavailable' "$broken_log" \
    || fail "broken SQLite header did not report physical-size fallback"

  bad_freelist_log="$sqlite_fixture/bad-freelist.log"
  warn_count=0
  fail_count=0
  CODEX_LOG_FAIL_BYTES=100000 \
    CODEX_LOG_WARN_BYTES=50000 \
    check_codex_log_file_size "$bad_freelist_db" >"$bad_freelist_log" 2>&1
  [ "$fail_count" -ge 1 ] || fail "freelist larger than page count did not use physical size"
  grep -Fq 'SQLite stats unavailable' "$bad_freelist_log" \
    || fail "invalid freelist did not report physical-size fallback"
  grep -Fq 'live data is larger than' "$bad_freelist_log" \
    && fail "invalid freelist used a clamped live size"

  wal_sidecar_log="$sqlite_fixture/wal-sidecar.log"
  warn_count=0
  fail_count=0
  CODEX_LOG_FAIL_BYTES=1000000 \
    CODEX_LOG_WARN_BYTES=5 \
    check_codex_log_file_size "$wal_file" >"$wal_sidecar_log" 2>&1
  [ "$fail_count" -eq 0 ] || fail "WAL physical-size check failed unexpectedly"
  grep -Fq 'is larger than' "$wal_sidecar_log" \
    || fail "WAL physical-size check did not warn"
fi

if ! command -v gitleaks >/dev/null 2>&1 \
  || ! command -v trufflehog >/dev/null 2>&1; then
  printf 'ok audit output privacy and recursive SSH private-key classification\n'
  exit 0
fi

(
  trap ':' EXIT INT TERM RETURN
  caller_traps_before="$(trap -p EXIT INT TERM RETURN)"
  scan_files_for_secrets </dev/null >/dev/null 2>&1
  caller_traps_after="$(trap -p EXIT INT TERM RETURN)"
  [ "$caller_traps_before" = "$caller_traps_after" ] \
    || fail "secret scan cleanup mutated caller traps"
)

secret_fixture="$tmp_root/secret-home"
mkdir -p "$secret_fixture"
# Build PEM/OpenSSH-shaped fixtures at runtime so gitleaks does not match this
# script as a repository secret. Bodies are non-functional placeholders.
{
  printf -- '-----BEGIN %s PRIVATE KEY-----\n' RSA
  printf '%s\n' 'MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF6PZGBlewn0LqYSdzaWQmJeJrQHL'
  printf -- '-----END %s PRIVATE KEY-----\n' RSA
} >"$secret_fixture/id_rsa"
{
  printf -- '-----BEGIN %s PRIVATE KEY-----\n' OPENSSH
  printf '%s\n' 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW'
  printf -- '-----END %s PRIVATE KEY-----\n' OPENSSH
} >"$secret_fixture/id_ed25519"
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

(
  count_gitleaks_findings() {
    return 1
  }
  json_output=0
  warn_count=0
  fail_count=0
  secret_scan_count=0
  secret_scan_finding_count=7
  secret_scan_rules_json='{"existing":3}'
  HOME="$secret_fixture" \
    scan_files_for_secrets < <(printf '%s\n' "$secret_fixture/id_rsa") >/dev/null 2>&1 || true
  [ "$secret_scan_finding_count" -eq 7 ] \
    || fail "failed finding count partially updated the aggregate total"
  [ "$secret_scan_rules_json" = '{"existing":3}' ] \
    || fail "failed finding count partially updated the aggregate rules"
)

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

missing_node_bin="$tmp_root/missing-node-bin"
missing_node_log="$tmp_root/missing-node.log"
mkdir -p "$missing_node_bin"
ln -s "$(command -v gitleaks)" "$missing_node_bin/gitleaks"
ln -s "$(command -v trufflehog)" "$missing_node_bin/trufflehog"
cat >"$missing_node_bin/node" <<'EOF'
#!/usr/bin/env bash
exit 127
EOF
chmod 755 "$missing_node_bin/node"
json_output=0
warn_count=0
fail_count=0
secret_scan_count=0
secret_scan_finding_count=0
secret_scan_rules_json=
PATH="$missing_node_bin:/usr/bin:/bin" \
  HOME="$secret_fixture" \
  scan_files_for_secrets < <(printf '%s\n' "$secret_fixture/id_rsa") \
  >"$missing_node_log" 2>&1 || true
[ "$fail_count" -ge 1 ] || fail "node-absent degrade path did not fail closed"
[ "$secret_scan_finding_count" -eq 0 ] \
  || fail "node-absent degrade path counted findings"
if grep -Fq 'finding rule=' "$missing_node_log"; then
  fail "node-absent degrade path still emitted locators"
fi
grep -Fq 'audit data tooling failed' "$missing_node_log" \
  || grep -Fq 'node is missing' "$missing_node_log" \
  || fail "node-absent degrade path did not warn"
grep -Fq 'gitleaks reported possible leaks' "$missing_node_log" \
  || fail "status-only gitleaks findings were reported as a scanner failure"

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
