#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mscp_dir="${MSCP_DIR:-$HOME/projects/security/macos_security}"
mscp_baseline="${MSCP_BASELINE:-800-53r5_moderate}"
mscp_script="${MSCP_SCRIPT:-}"
run_mscp=1
allow_sudo_prompt=0
json_output=0
warn_count=0
fail_count=0

usage() {
  cat <<'USAGE'
Usage:
  scripts/security/audit.sh [options]

Runs a non-destructive security audit for this Mac bootstrap repo:
  - repository secret scans with gitleaks and, when installed, trufflehog
  - optional macOS Security Compliance Project check-only audit

Options:
  --mscp-dir PATH          macOS Security Compliance Project checkout
                           default: ~/projects/security/macos_security
  --mscp-baseline NAME     mSCP baseline name, default: 800-53r5_moderate
  --mscp-script PATH       explicit generated mSCP compliance script
  --skip-mscp              skip mSCP audit
  --allow-sudo-prompt      allow mSCP to prompt for sudo; default uses sudo -n
  --json                   print a machine-readable summary instead of prose
  -h, --help

This script never runs mSCP remediation. It only runs --check.
USAGE
}

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

print_json_summary() {
  local status="pass"
  if [ "$fail_count" -gt 0 ]; then
    status="fail"
  elif [ "$warn_count" -gt 0 ]; then
    status="warn"
  fi

  printf '{"audit":'
  json_string "repo-security"
  printf ',"status":'
  json_string "$status"
  printf ',"failed":%s,"warnings":%s,"mscp":' "$fail_count" "$warn_count"
  if [ "$run_mscp" -eq 1 ]; then
    json_string "enabled"
  else
    json_string "skipped"
  fi
  printf '}\n'
}

run_audit_command() {
  if [ "$json_output" -eq 1 ]; then
    "$@" >/dev/null 2>&1
  else
    "$@"
  fi
}

macos_branch() {
  local major

  major="$(sw_vers -productVersion | awk -F. '{ print $1 }')"
  case "$major" in
    15) printf 'sequoia\n' ;;
    14) printf 'sonoma\n' ;;
    13) printf 'ventura\n' ;;
    12) printf 'monterey\n' ;;
    *) printf 'unknown\n' ;;
  esac
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mscp-dir)
      mscp_dir="${2:-}"
      shift 2
      ;;
    --mscp-baseline)
      mscp_baseline="${2:-}"
      shift 2
      ;;
    --mscp-script)
      mscp_script="${2:-}"
      shift 2
      ;;
    --skip-mscp)
      run_mscp=0
      shift
      ;;
    --allow-sudo-prompt)
      allow_sudo_prompt=1
      shift
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

if [ -z "$mscp_dir" ] || [ -z "$mscp_baseline" ]; then
  usage >&2
  exit 2
fi

section "repository secret scan"

if command -v gitleaks >/dev/null 2>&1; then
  if run_audit_command gitleaks detect --source "$repo_root" --redact --verbose; then
    ok "gitleaks found no leaks"
  else
    fail_check "gitleaks reported possible leaks"
  fi
else
  warn "gitleaks is not installed"
fi

if command -v trufflehog >/dev/null 2>&1; then
  if run_audit_command trufflehog git "file://$repo_root" --no-update --only-verified; then
    ok "trufflehog found no verified leaks"
  else
    fail_check "trufflehog reported verified leaks or failed"
  fi
else
  warn "trufflehog is not installed"
fi

section "macOS compliance baseline"

if [ "$run_mscp" -eq 0 ]; then
  ok "mSCP audit skipped"
else
  expected_branch="$(macos_branch)"

  if [ ! -d "$mscp_dir/.git" ]; then
    warn "mSCP checkout missing at $mscp_dir"
    warn "clone https://github.com/usnistgov/macos_security.git and check out the macOS branch before running this audit"
  else
    current_branch="$(git -C "$mscp_dir" branch --show-current 2>/dev/null || true)"
    if [ "$expected_branch" != "unknown" ] && [ "$current_branch" != "$expected_branch" ]; then
      warn "mSCP branch is $current_branch; expected $expected_branch for this macOS version"
    else
      ok "mSCP branch looks correct: ${current_branch:-detached}"
    fi

    if [ -z "$mscp_script" ]; then
      mscp_script="$mscp_dir/build/$mscp_baseline/${mscp_baseline}_compliance.sh"
    fi

    if [ ! -x "$mscp_script" ]; then
      warn "generated mSCP compliance script missing: $mscp_script"
      warn "generate it with: cd $mscp_dir && ./scripts/generate_baseline.py -k $mscp_baseline && ./scripts/generate_guidance.py -s baselines/$mscp_baseline.yaml"
    elif [ "$(id -u)" -eq 0 ]; then
      if run_audit_command zsh "$mscp_script" --check; then
        ok "mSCP check passed"
      else
        fail_check "mSCP check reported non-compliance"
      fi
    elif [ "$allow_sudo_prompt" -eq 1 ]; then
      if run_audit_command sudo zsh "$mscp_script" --check; then
        ok "mSCP check passed"
      else
        fail_check "mSCP check reported non-compliance"
      fi
    elif sudo -n true >/dev/null 2>&1; then
      if run_audit_command sudo -n zsh "$mscp_script" --check; then
        ok "mSCP check passed"
      else
        fail_check "mSCP check reported non-compliance"
      fi
    else
      warn "mSCP check needs sudo; rerun with --allow-sudo-prompt or run sudo zsh $mscp_script --check"
    fi
  fi
fi

if [ "$json_output" -eq 1 ]; then
  print_json_summary
else
  printf '\nsecurity audit summary: %s failed, %s warnings\n' "$fail_count" "$warn_count"
fi

if [ "$fail_count" -gt 0 ]; then
  exit 1
fi
