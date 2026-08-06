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

  command -v python3 >/dev/null 2>&1 || return 1
  python3 - "$scan_root" "$report_path" <<'PY'
import json
import sys
from pathlib import Path

scan_root = Path(sys.argv[1])
report_path = Path(sys.argv[2])
raw = report_path.read_text(encoding="utf-8") if report_path.is_file() else "[]"
try:
    findings = json.loads(raw or "[]")
except json.JSONDecodeError:
    findings = []

if not isinstance(findings, list):
    findings = []


def root_prefixes(root):
    prefixes = []
    for candidate in (root, root.resolve()):
        text = str(candidate).rstrip("/")
        prefixes.append(text)
        if text.startswith("/private/"):
            prefixes.append(text[len("/private") :])
        elif text.startswith("/var/"):
            prefixes.append("/private" + text)
    # Preserve order while deduplicating.
    seen = set()
    ordered = []
    for prefix in prefixes:
        if prefix not in seen:
            seen.add(prefix)
            ordered.append(prefix)
    return ordered


def staged_relative(locator):
    if not locator:
        return "unknown"
    for prefix in root_prefixes(scan_root):
        marker = prefix + "/"
        if locator.startswith(marker):
            relative = locator[len(marker) :]
            if relative and not relative.startswith("/") and ".." not in Path(relative).parts:
                return relative
    return "unknown"


for finding in findings:
    rule = str(finding.get("RuleID") or "unknown")
    # With --follow-symlinks, File is the target; SymlinkFile is the staged path.
    locator = str(finding.get("SymlinkFile") or finding.get("File") or "")
    print(f"{rule}\t{staged_relative(locator)}")
PY
}

merge_secret_scan_rule_counts() {
  local existing_json="$1"
  local report_path="$2"

  command -v python3 >/dev/null 2>&1 || {
    if [ -n "$existing_json" ]; then
      printf '%s\n' "$existing_json"
    else
      printf '%s\n' '{}'
    fi
    return 1
  }
  python3 - "$existing_json" "$report_path" <<'PY'
import json
import sys
from collections import Counter
from pathlib import Path

existing_raw = sys.argv[1] or "{}"
report_path = Path(sys.argv[2])
try:
    existing = json.loads(existing_raw)
except json.JSONDecodeError:
    existing = {}
if not isinstance(existing, dict):
    existing = {}

raw = report_path.read_text(encoding="utf-8") if report_path.is_file() else "[]"
try:
    findings = json.loads(raw or "[]")
except json.JSONDecodeError:
    findings = []
if not isinstance(findings, list):
    findings = []

counts = Counter({str(key): int(value) for key, value in existing.items()})
counts.update(str(item.get("RuleID") or "unknown") for item in findings)
print(json.dumps(dict(sorted(counts.items())), separators=(",", ":")))
PY
}

count_gitleaks_findings() {
  local report_path="$1"

  command -v python3 >/dev/null 2>&1 || {
    printf '0\n'
    return 1
  }
  python3 - "$report_path" <<'PY'
import json
import sys
from pathlib import Path

raw = Path(sys.argv[1]).read_text(encoding="utf-8") if Path(sys.argv[1]).is_file() else "[]"
try:
    findings = json.loads(raw or "[]")
except json.JSONDecodeError:
    findings = []
print(len(findings) if isinstance(findings, list) else 0)
PY
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
  local have_python=0

  if ! command -v gitleaks >/dev/null 2>&1; then
    fail_check "gitleaks is missing for local secret scan"
    return
  fi

  if ! command -v trufflehog >/dev/null 2>&1; then
    fail_check "trufflehog is missing for local secret scan"
    return
  fi

  if command -v python3 >/dev/null 2>&1; then
    have_python=1
  else
    warn "python3 is missing; gitleaks locators and rule aggregates are unavailable"
  fi

  scan_root="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-secret-scan.XXXXXX")"
  report_dir="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-secret-report.XXXXXX")"
  chmod 700 "$scan_root" "$report_dir"
  report_path="$report_dir/gitleaks-report.json"
  : >"$report_path"
  chmod 600 "$report_path"
  # RETURN keeps caller EXIT traps intact when this library is sourced.
  trap 'rm -rf "$scan_root" "$report_dir"' RETURN

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
    return
  fi

  # Collect findings into an owner-only report outside the staged scan tree.
  # Never stream raw scanner output that can include matched secret material.
  gitleaks dir \
    --follow-symlinks \
    --redact \
    --no-banner \
    --log-level error \
    --report-format json \
    --report-path "$report_path" \
    "$scan_root" >/dev/null 2>&1 || gitleaks_status=$?
  chmod 600 "$report_path" 2>/dev/null || true

  if [ "$have_python" -eq 1 ]; then
    secret_scan_rules_json="$(
      merge_secret_scan_rule_counts "$(secret_scan_rules_json_or_empty_object)" "$report_path"
    )"
    finding_count="$(count_gitleaks_findings "$report_path")"
    secret_scan_finding_count=$((secret_scan_finding_count + finding_count))
  fi

  if [ "$have_python" -eq 1 ]; then
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
    if [ "$gitleaks_status" -eq 0 ]; then
      ok "gitleaks found no leaks in $linked_count local config files"
    else
      fail_check "gitleaks reported possible leaks in local config files"
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
