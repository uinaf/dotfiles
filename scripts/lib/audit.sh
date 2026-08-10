#!/usr/bin/env bash

audit_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=scripts/lib/config-paths.sh
. "$audit_lib_dir/config-paths.sh"

: "${json_output:=0}"
: "${warn_count:=0}"
: "${fail_count:=0}"
: "${secret_scan_count:=0}"
: "${secret_scan_finding_count:=0}"
# Keep this empty by default. Do not use `${var:-{}}` — bash treats the closing
# brace of `{}` as the end of the parameter expansion.
: "${secret_scan_rules_json:=}"

section() {
  [ "$json_output" -eq 1 ] && return
  printf '\n## %s\n' "$1"
}

ok() {
  [ "$json_output" -eq 1 ] && return
  printf 'ok %s\n' "$1"
}

warn() {
  warn_count=$((warn_count + 1))
  [ "$json_output" -eq 1 ] && return
  printf 'warn %s\n' "$1" >&2
}

fail_check() {
  fail_count=$((fail_count + 1))
  [ "$json_output" -eq 1 ] && return
  printf 'FAILED: %s\n' "$1" >&2
}

json_string() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

mode_of() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
    return
  fi

  stat -f '%Lp' "$1"
}

owner_of() {
  if stat -c '%U' "$1" >/dev/null 2>&1; then
    stat -c '%U' "$1"
    return
  fi

  stat -f '%Su' "$1"
}

size_of() {
  if stat -c '%s' "$1" >/dev/null 2>&1; then
    stat -c '%s' "$1"
    return
  fi

  stat -f '%z' "$1"
}

human_bytes() {
  local bytes="${1:-0}"
  local units=(B KB MB GB TB)
  local unit=0
  local whole
  local frac

  if ! [[ "$bytes" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$bytes"
    return
  fi

  while [ "$bytes" -ge 1024 ] && [ "$unit" -lt 4 ]; do
    whole=$((bytes / 1024))
    frac=$(((bytes % 1024) * 10 / 1024))
    bytes=$whole
    unit=$((unit + 1))
  done

  if [ "$unit" -eq 0 ] || [ "$frac" -eq 0 ]; then
    printf '%s%s\n' "$bytes" "${units[$unit]}"
  else
    printf '%s.%s%s\n' "$bytes" "$frac" "${units[$unit]}"
  fi
}

# True when path begins with the SQLite database header magic.
is_sqlite_database_file() {
  local path="$1"
  local magic

  [ -r "$path" ] || return 1
  magic="$(dd if="$path" bs=1 count=15 2>/dev/null || true)"
  [ "$magic" = "SQLite format 3" ]
}

# Read SQLite page stats from the 100-byte DB header without opening the
# database engine. Works for WAL-mode files and never creates -wal/-shm.
# Prints: page_size page_count freelist_count
sqlite_page_stats() {
  local path="$1"

  [ -r "$path" ] || return 1
  command -v node >/dev/null 2>&1 || return 1
  node "$audit_lib_dir/../audit/data.ts" sqlite-stats "$path"
}

# Check a Codex/log SQLite database against live-data thresholds, with a
# physical-size fallback when page stats are unavailable.
# Override thresholds via CODEX_LOG_*_BYTES / CODEX_LOG_FREELIST_WARN_RATIO.
check_sqlite_log_size() {
  local path="$1"
  local fail_bytes="${CODEX_LOG_FAIL_BYTES:-524288000}"
  local warn_bytes="${CODEX_LOG_WARN_BYTES:-209715200}"
  local reclaim_warn_bytes="${CODEX_LOG_RECLAIM_WARN_BYTES:-209715200}"
  local freelist_warn_ratio="${CODEX_LOG_FREELIST_WARN_RATIO:-50}"
  local reclaim_floor_bytes="${CODEX_LOG_RECLAIM_FLOOR_BYTES:-52428800}"
  local physical_bytes
  local stats
  local page_size
  local page_count
  local freelist_count
  local live_pages
  local live_bytes
  local reclaimable_bytes
  local freelist_ratio=0
  local high_reclaimable=0
  local summary

  physical_bytes="$(size_of "$path" 2>/dev/null || printf 0)"
  if ! [[ "$physical_bytes" =~ ^[0-9]+$ ]]; then
    physical_bytes=0
  fi

  if ! stats="$(sqlite_page_stats "$path")"; then
    if [ "$physical_bytes" -ge "$fail_bytes" ]; then
      fail_check "$path is larger than $(human_bytes "$fail_bytes") (physical size; SQLite stats unavailable)"
    elif [ "$physical_bytes" -ge "$warn_bytes" ]; then
      warn "$path is larger than $(human_bytes "$warn_bytes") (physical size; SQLite stats unavailable)"
    else
      ok "$path size is under $(human_bytes "$warn_bytes") (physical size; SQLite stats unavailable)"
    fi
    return
  fi

  read -r page_size page_count freelist_count <<< "$stats"
  live_pages=$((page_count - freelist_count))
  live_bytes=$((live_pages * page_size))
  reclaimable_bytes=$((freelist_count * page_size))
  if [ "$page_count" -gt 0 ]; then
    freelist_ratio=$((freelist_count * 100 / page_count))
  fi

  summary="physical=$(human_bytes "$physical_bytes") live=$(human_bytes "$live_bytes") reclaimable=$(human_bytes "$reclaimable_bytes") freelist=${freelist_ratio}%"

  if [ "$live_bytes" -ge "$fail_bytes" ]; then
    fail_check "$path live data is larger than $(human_bytes "$fail_bytes") ($summary)"
    return
  fi

  if [ "$live_bytes" -ge "$warn_bytes" ]; then
    warn "$path live data is larger than $(human_bytes "$warn_bytes") ($summary)"
  fi
  if [ "$reclaimable_bytes" -ge "$reclaim_warn_bytes" ] \
    || {
      [ "$freelist_ratio" -ge "$freelist_warn_ratio" ] \
        && [ "$reclaimable_bytes" -ge "$reclaim_floor_bytes" ]
    }; then
    high_reclaimable=1
    warn "$path has high reclaimable SQLite space ($summary)"
  fi
  if [ "$live_bytes" -lt "$warn_bytes" ] && [ "$high_reclaimable" -eq 0 ]; then
    ok "$path size is healthy ($summary)"
  fi
}

check_codex_log_file_size() {
  local path="$1"
  local fail_bytes="${CODEX_LOG_FAIL_BYTES:-524288000}"
  local warn_bytes="${CODEX_LOG_WARN_BYTES:-209715200}"
  local physical_bytes

  if is_sqlite_database_file "$path"; then
    check_sqlite_log_size "$path"
    return
  fi

  # WAL and other non-database companions keep physical-size checks.
  physical_bytes="$(size_of "$path" 2>/dev/null || printf 0)"
  if ! [[ "$physical_bytes" =~ ^[0-9]+$ ]]; then
    physical_bytes=0
  fi

  if [ "$physical_bytes" -ge "$fail_bytes" ]; then
    fail_check "$path is larger than $(human_bytes "$fail_bytes")"
  elif [ "$physical_bytes" -ge "$warn_bytes" ]; then
    warn "$path is larger than $(human_bytes "$warn_bytes")"
  else
    ok "$path size is under $(human_bytes "$warn_bytes")"
  fi
}

check_mode_any() {
  local missing_severity="$1"
  local path="$2"
  shift 2
  local mode
  local expected

  if [ ! -e "$path" ]; then
    if [ "$missing_severity" = "fail" ]; then
      fail_check "missing $path"
    else
      warn "missing $path"
    fi
    return
  fi

  mode="$(mode_of "$path")"
  for expected in "$@"; do
    if [ "$mode" = "$expected" ]; then
      ok "$path mode $mode"
      return
    fi
  done

  fail_check "$path mode is $mode, expected one of: $*"
}

check_ssh_private_key_modes() {
  local ssh_dir="${1:-$HOME/.ssh}"
  local key_path
  local key_mode

  if [ ! -d "$ssh_dir" ]; then
    warn "missing $ssh_dir"
    return
  fi

  while IFS= read -r -d '' key_path; do
    if [ ! -r "$key_path" ]; then
      warn "cannot inspect SSH file $key_path"
      continue
    fi
    if ! grep -Eq \
      '^(-----BEGIN ([A-Z0-9]+ )?PRIVATE KEY-----|---- BEGIN SSH2 (ENCRYPTED )?PRIVATE KEY ----|PuTTY-User-Key-File-[23]:)' \
      "$key_path"; then
      continue
    fi

    key_mode="$(mode_of "$key_path")"
    if [ $((8#$key_mode & 0077)) -eq 0 ]; then
      ok "$key_path mode $key_mode"
    else
      fail_check "$key_path mode $key_mode is group/world accessible"
    fi
  done < <(find "$ssh_dir" -type f -print0 2>/dev/null)
}

check_pattern_absent() {
  local path="$1"
  local pattern="$2"
  local label="$3"
  local severity="$4"

  if [ ! -e "$path" ]; then
    return
  fi

  if [ ! -r "$path" ]; then
    warn "cannot read $path for $label"
    return
  fi

  if grep -Eq "$pattern" "$path"; then
    if [ "$severity" = "fail" ]; then
      fail_check "$path contains $label"
    else
      warn "$path contains $label"
    fi
  else
    ok "$path does not contain $label"
  fi
}

scan_file_for_secret_pattern() {
  local path="$1"
  local pattern="$2"
  local label="$3"

  if [ ! -r "$path" ]; then
    warn "cannot read $path for $label"
    return
  fi

  secret_scan_count=$((secret_scan_count + 1))
  if grep -Eq "$pattern" "$path"; then
    fail_check "$path contains $label"
  fi
}

# Read a gitleaks JSON report and emit only safe locator fields.
# Prints "rule<TAB>relative-path" lines to stdout. Never prints Match/Secret.
emit_gitleaks_finding_locators() {
  local scan_root="$1"
  local report_path="$2"

  command -v node >/dev/null 2>&1 || return 1
  node "$audit_lib_dir/../audit/data.ts" gitleaks-locators "$scan_root" "$report_path"
}

merge_secret_scan_rule_counts() {
  local existing_json="$1"
  local report_path="$2"

  command -v node >/dev/null 2>&1 || {
    if [ -n "$existing_json" ]; then
      printf '%s\n' "$existing_json"
    else
      printf '%s\n' '{}'
    fi
    return 1
  }
  node "$audit_lib_dir/../audit/data.ts" gitleaks-merge "$existing_json" "$report_path"
}

count_gitleaks_findings() {
  local report_path="$1"

  command -v node >/dev/null 2>&1 || {
    printf '0\n'
    return 1
  }
  node "$audit_lib_dir/../audit/data.ts" gitleaks-count "$report_path"
}

secret_scan_rules_json_or_empty_object() {
  if [ -n "${secret_scan_rules_json:-}" ]; then
    printf '%s\n' "$secret_scan_rules_json"
  else
    printf '%s\n' '{}'
  fi
}

scan_files_for_secrets() {
  local scan_root
  local report_dir
  local report_path
  local path
  local rel_path
  local link_path
  local linked_count=0
  local trufflehog_status
  local gitleaks_status=0
  local finding_count=0
  local rule
  local staged_path
  local have_audit_data=0
  local secret_scan_prev_return

  if ! command -v gitleaks >/dev/null 2>&1; then
    fail_check "gitleaks is missing for local secret scan"
    return
  fi

  if ! command -v trufflehog >/dev/null 2>&1; then
    fail_check "trufflehog is missing for local secret scan"
    return
  fi

  if command -v node >/dev/null 2>&1; then
    have_audit_data=1
  else
    warn "node is missing; gitleaks locators and rule aggregates are unavailable"
  fi

  scan_root="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-secret-scan.XXXXXX")"
  report_dir="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-secret-report.XXXXXX")"
  chmod 700 "$scan_root" "$report_dir"
  report_path="$report_dir/gitleaks-report.json"
  : >"$report_path"
  chmod 600 "$report_path"
  # Only RETURN is trapped so caller EXIT/INT/TERM handlers stay untouched.
  # Explicit cleanup calls cover normal paths; RETURN covers early returns.
  secret_scan_prev_return="$(trap -p RETURN)"
  cleanup_secret_scan_tmp() {
    rm -rf "${scan_root:-}" "${report_dir:-}"
    if [ -n "${secret_scan_prev_return:-}" ]; then
      eval "$secret_scan_prev_return"
    else
      trap - RETURN
    fi
  }
  trap cleanup_secret_scan_tmp RETURN

  while IFS= read -r path; do
    [ -n "$path" ] || continue

    if [ ! -r "$path" ]; then
      warn "cannot read $path for gitleaks secret scan"
      continue
    fi

    secret_scan_count=$((secret_scan_count + 1))

    case "$path" in
      "$HOME"/*) rel_path="home/${path#"$HOME"/}" ;;
      /*) rel_path="root/${path#/}" ;;
      *) rel_path="relative/$path" ;;
    esac

    link_path="$scan_root/$rel_path"
    mkdir -p "$(dirname "$link_path")"
    ln -s "$path" "$link_path"
    linked_count=$((linked_count + 1))
  done

  if [ "$linked_count" -eq 0 ]; then
    warn "no readable local config files found for gitleaks secret scan"
    cleanup_secret_scan_tmp
    return
  fi

  # Collect findings into an owner-only report outside the staged scan tree.
  # Never stream raw scanner output that can include matched secret material.
  gitleaks dir \
    --follow-symlinks \
    --redact \
    --exit-code 183 \
    --no-banner \
    --log-level error \
    --report-format json \
    --report-path "$report_path" \
    "$scan_root" >/dev/null 2>&1 || gitleaks_status=$?
  chmod 600 "$report_path" 2>/dev/null || true

  if [ "$have_audit_data" -eq 1 ]; then
    local next_rules_json
    local next_finding_count
    if ! next_rules_json="$(
      merge_secret_scan_rule_counts "$(secret_scan_rules_json_or_empty_object)" "$report_path"
    )"; then
      have_audit_data=0
      warn "audit data tooling failed while summarizing gitleaks findings; falling back to status-only reporting"
    elif ! next_finding_count="$(count_gitleaks_findings "$report_path")" \
      || ! [[ "$next_finding_count" =~ ^[0-9]+$ ]]; then
      have_audit_data=0
      warn "audit data tooling failed while counting gitleaks findings; falling back to status-only reporting"
    else
      secret_scan_rules_json="$next_rules_json"
      finding_count="$next_finding_count"
      secret_scan_finding_count=$((secret_scan_finding_count + finding_count))
    fi
  fi

  if [ "$have_audit_data" -eq 1 ]; then
    if [ "$finding_count" -eq 0 ] && [ "$gitleaks_status" -eq 0 ]; then
      ok "gitleaks found no leaks in $linked_count local config files"
    elif [ "$finding_count" -gt 0 ]; then
      if [ "$json_output" -eq 0 ]; then
        while IFS=$'\t' read -r rule staged_path; do
          [ -n "$rule" ] || continue
          printf 'finding rule=%s path=%s\n' "$rule" "$staged_path" >&2
        done < <(emit_gitleaks_finding_locators "$scan_root" "$report_path")
      fi
      fail_check "gitleaks reported possible leaks in local config files"
    else
      fail_check "gitleaks local config scan failed"
    fi
  else
    # Without the typed data tool, status is the only signal: 183 = findings, other nonzero = tool error.
    if [ "$gitleaks_status" -eq 0 ]; then
      ok "gitleaks found no leaks in $linked_count local config files"
    elif [ "$gitleaks_status" -eq 183 ]; then
      fail_check "gitleaks reported possible leaks in local config files"
    else
      fail_check "gitleaks local config scan failed"
    fi
  fi

  trufflehog_status=0
  if [ "$json_output" -eq 1 ]; then
    trufflehog filesystem \
      --no-update \
      --no-color \
      --results=verified \
      --fail \
      --force-skip-binaries \
      --force-skip-archives \
      --max-symlink-depth=1 \
      "$scan_root" >/dev/null 2>&1 || trufflehog_status=$?
  else
    trufflehog filesystem \
      --no-update \
      --no-color \
      --results=verified \
      --fail \
      --force-skip-binaries \
      --force-skip-archives \
      --max-symlink-depth=1 \
      "$scan_root" || trufflehog_status=$?
  fi

  if [ "$trufflehog_status" -eq 0 ]; then
    ok "trufflehog found no verified leaks in $linked_count local config files"
  elif [ "$trufflehog_status" -eq 183 ]; then
    fail_check "trufflehog reported verified leaks in local config files"
  else
    fail_check "trufflehog local config scan failed"
  fi

  cleanup_secret_scan_tmp
}

scan_files_with_gitleaks() {
  scan_files_for_secrets "$@"
}

find_matching_files() {
  local base="$1"
  shift

  if [ -d "$base" ]; then
    find "$base" "$@" -print 2>/dev/null || true
  fi
}

load_audit_policy() {
  local policy_path
  policy_path="$(dotfiles_resolve_config_file "${AUDIT_POLICY_FILE:-}" audit.env)"

  if [ ! -e "$policy_path" ]; then
    return 0
  fi

  # Public-safe local policy only. Do not put secrets in this file.
  # shellcheck disable=SC1090
  . "$policy_path"
  ok "loaded audit policy from $policy_path"
}

word_in_list() {
  local needle="$1"
  local words="$2"
  local word

  for word in $words; do
    if [ "$word" = "$needle" ]; then
      return 0
    fi
  done

  return 1
}

warn_on_broad_gh_scopes() {
  local sensitive_scopes="${GH_SENSITIVE_SCOPES:-delete_repo workflow admin:org admin:public_key admin:repo_hook write:packages}"
  local accepted_scopes="${GH_ACCEPTED_SCOPES:-}"
  local status_output
  local scopes_line
  local normalized_scopes
  local scope

  command -v gh >/dev/null 2>&1 || return

  status_output="$(gh auth status -h github.com 2>&1 || true)"
  scopes_line="$(printf '%s\n' "$status_output" | sed -nE "s/.*Token scopes: (.*)/\1/p" | tail -n 1)"
  [ -n "$scopes_line" ] || return
  normalized_scopes="$(printf '%s\n' "$scopes_line" | tr -d "',")"

  for scope in $sensitive_scopes; do
    if word_in_list "$scope" "$normalized_scopes"; then
      if word_in_list "$scope" "$accepted_scopes"; then
        ok "gh token broad scope accepted by policy: $scope"
      else
        warn "gh token has broad scope outside policy: $scope"
      fi
    fi
  done
}

emit_path_if_exists() {
  local path="$1"

  if [ -e "$path" ]; then
    printf '%s\n' "$path"
  fi
}

emit_home_dotfiles() {
  find_matching_files "$HOME" -maxdepth 1 -type f -name '.*' \
    ! -name '.CFUserTextEncoding' \
    ! -name '.DS_Store' \
    ! -name '.localized'
}
