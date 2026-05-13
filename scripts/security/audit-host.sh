#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
allow_sudo_prompt=0
json_output=0
warn_count=0
fail_count=0
min_hardening_index=""
keep_artifacts_dir=""

# shellcheck source=scripts/lib/audit.sh
. "$repo_root/scripts/lib/audit.sh"

usage() {
  cat <<'USAGE'
Usage:
  scripts/security/audit-host.sh [options]

Runs a non-destructive host security audit with Lynis.

Options:
  --allow-sudo-prompt        run Lynis through sudo for deeper OS checks
  --min-hardening-index N    fail when Lynis reports a lower hardening index
  --keep-artifacts DIR       copy the Lynis report/log there for manual review
  --json                     print a machine-readable summary instead of prose
  -h, --help

The default run is intentionally lightweight and does not prompt for sudo. It
summarizes Lynis warnings and suggestions without printing full host reports.
USAGE
}

print_json_summary() {
  local status="pass"
  if [ "$fail_count" -gt 0 ]; then
    status="fail"
  elif [ "$warn_count" -gt 0 ]; then
    status="warn"
  fi

  printf '{"audit":'
  json_string "host-security"
  printf ',"status":'
  json_string "$status"
  printf ',"failed":%s,"warnings":%s' "$fail_count" "$warn_count"
  printf ',"lynis_version":'
  json_string "$lynis_version"
  printf ',"hardening_index":%s' "${hardening_index:-0}"
  printf ',"tests_performed":%s' "${tests_performed:-0}"
  printf ',"lynis_warnings":%s' "${lynis_warning_count:-0}"
  printf ',"lynis_suggestions":%s' "${lynis_suggestion_count:-0}"
  printf ',"privileged":'
  if [ "$ran_privileged" -eq 1 ]; then
    printf 'true'
  else
    printf 'false'
  fi
  printf '}\n'
}

lynis_field() {
  local report="$1"
  local key="$2"
  awk -F= -v key="$key" '$1 == key { print $2; exit }' "$report"
}

lynis_entry_count() {
  local report="$1"
  local key="$2"
  grep -Ec "^${key}\\[\\]=" "$report" 2>/dev/null || true
}

print_lynis_entries() {
  local report="$1"
  local key="$2"
  local limit="$3"
  local printed=0
  local line
  local value
  local id
  local rest
  local text

  while IFS= read -r line; do
    value="${line#*=}"
    id="${value%%|*}"
    rest="${value#*|}"
    text="${rest%%|*}"
    printf '  - %s: %s\n' "$id" "$text"
    printed=$((printed + 1))
    [ "$printed" -lt "$limit" ] || break
  done < <(grep -E "^${key}\\[\\]=" "$report" 2>/dev/null || true)
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --allow-sudo-prompt)
      allow_sudo_prompt=1
      shift
      ;;
    --min-hardening-index)
      min_hardening_index="${2:-}"
      shift 2
      ;;
    --keep-artifacts)
      keep_artifacts_dir="${2:-}"
      shift 2
      ;;
    --json)
      json_output=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -n "$min_hardening_index" ] && ! [[ "$min_hardening_index" =~ ^[0-9]+$ ]]; then
  printf 'invalid --min-hardening-index: %s\n' "$min_hardening_index" >&2
  exit 2
fi

section "host security audit"

if ! command -v lynis >/dev/null 2>&1; then
  fail_check "lynis is missing"
  lynis_version=""
  hardening_index=0
  tests_performed=0
  lynis_warning_count=0
  lynis_suggestion_count=0
  ran_privileged=0
else
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/uinaf-lynis.XXXXXX")"
  chmod 700 "$tmp_dir"
  report_file="$tmp_dir/lynis-report.dat"
  log_file="$tmp_dir/lynis.log"
  output_file="$tmp_dir/lynis-output.txt"
  lynis_status=0
  ran_privileged=0

  lynis_cmd=(lynis audit system --quick --no-colors --report-file "$report_file" --log-file "$log_file")

  if [ "$(id -u)" -eq 0 ]; then
    ran_privileged=1
    "${lynis_cmd[@]}" >"$output_file" 2>&1 || lynis_status=$?
  elif [ "$allow_sudo_prompt" -eq 1 ]; then
    ran_privileged=1
    # shellcheck disable=SC2024 # Output intentionally lands in the caller-owned temp file.
    sudo "${lynis_cmd[@]}" >"$output_file" 2>&1 || lynis_status=$?
  else
    "${lynis_cmd[@]}" >"$output_file" 2>&1 || lynis_status=$?
    warn "running Lynis without sudo; rerun with --allow-sudo-prompt for deeper OS checks"
  fi

  lynis_version="$(lynis --version 2>/dev/null || true)"

  if [ "$lynis_status" -ne 0 ]; then
    fail_check "lynis exited with status $lynis_status"
    if [ "$json_output" -eq 0 ]; then
      sed -n '1,40p' "$output_file" >&2
    fi
  fi

  if [ -r "$report_file" ]; then
    hardening_index="$(lynis_field "$report_file" hardening_index)"
    tests_performed="$(lynis_field "$report_file" lynis_tests_done)"
    lynis_warning_count="$(lynis_entry_count "$report_file" warning)"
    lynis_suggestion_count="$(lynis_entry_count "$report_file" suggestion)"

    hardening_index="${hardening_index:-0}"
    tests_performed="${tests_performed:-0}"
    lynis_warning_count="${lynis_warning_count:-0}"
    lynis_suggestion_count="${lynis_suggestion_count:-0}"

    if [ "$lynis_warning_count" -gt 0 ]; then
      warn "lynis reported $lynis_warning_count warnings"
    else
      ok "lynis reported no warnings"
    fi

    if [ -n "$min_hardening_index" ] && [ "$hardening_index" -lt "$min_hardening_index" ]; then
      fail_check "lynis hardening index $hardening_index is below $min_hardening_index"
    else
      ok "lynis hardening index $hardening_index"
    fi

    if [ "$json_output" -eq 0 ]; then
      printf 'lynis tests performed: %s\n' "$tests_performed"
      printf 'lynis suggestions: %s\n' "$lynis_suggestion_count"

      if [ "$lynis_warning_count" -gt 0 ]; then
        printf '\nLynis warnings:\n'
        print_lynis_entries "$report_file" warning 10
      fi

      if [ "$lynis_suggestion_count" -gt 0 ]; then
        printf '\nTop Lynis suggestions:\n'
        print_lynis_entries "$report_file" suggestion 10
      fi
    fi
  else
    hardening_index=0
    tests_performed=0
    lynis_warning_count=0
    lynis_suggestion_count=0
    fail_check "lynis did not write a report file"
  fi

  if [ -n "$keep_artifacts_dir" ]; then
    mkdir -p "$keep_artifacts_dir"
    chmod 700 "$keep_artifacts_dir"
    cp "$report_file" "$keep_artifacts_dir/lynis-report.dat"
    cp "$log_file" "$keep_artifacts_dir/lynis.log"
    if [ "$json_output" -eq 0 ]; then
      warn "kept full Lynis artifacts under $keep_artifacts_dir; review before sharing"
    fi
  fi

  rm -rf "$tmp_dir"
fi

if [ "$json_output" -eq 1 ]; then
  print_json_summary
else
  printf '\nhost security audit summary: %s failed, %s warnings\n' "$fail_count" "$warn_count"
fi

if [ "$fail_count" -gt 0 ]; then
  exit 1
fi
