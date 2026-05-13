#!/usr/bin/env bash
set -euo pipefail

expected_admin_users="${UINAF_EXPECTED_ADMIN_USERS:-}"
json_output=0
warn_count=0
fail_count=0

usage() {
  cat <<'USAGE'
Usage:
  scripts/security/audit-personal.sh [options]

Runs a non-destructive personal/non-devbox drift audit for the current Unix user.

Options:
  --expected-admin-users LIST   space-separated admin users expected on this Mac
  --json                        print a machine-readable summary instead of prose
  -h, --help

The script checks local secret boundaries, Git/GitHub identity state, SSH key
permissions, Tailscale state, and whether devbox-only service-account state has
drifted onto a personal setup. It does not print secret values.
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
  json_string "personal-security"
  printf ',"status":'
  json_string "$status"
  printf ',"failed":%s,"warnings":%s,"user":' "$fail_count" "$warn_count"
  json_string "$USER"
  printf '}\n'
}

mode_of() {
  stat -f '%Lp' "$1"
}

check_mode_any() {
  local path="$1"
  shift
  local mode
  local expected

  if [ ! -e "$path" ]; then
    warn "missing $path"
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

scan_files_with_gitleaks() {
  local scan_root
  local path
  local rel_path
  local link_path
  local linked_count=0

  if ! command -v gitleaks >/dev/null 2>&1; then
    fail_check "gitleaks is missing for local secret scan"
    return
  fi

  scan_root="$(mktemp -d "${TMPDIR:-/tmp}/uinaf-secret-scan.XXXXXX")"
  chmod 700 "$scan_root"

  while IFS= read -r path; do
    [ -n "$path" ] || continue

    if [ ! -r "$path" ]; then
      warn "cannot read $path for gitleaks secret scan"
      continue
    fi

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
    rm -rf "$scan_root"
    return
  fi

  if [ "$json_output" -eq 1 ]; then
    if gitleaks dir --follow-symlinks --redact --no-banner --log-level error "$scan_root" >/dev/null 2>&1; then
      ok "gitleaks found no leaks in $linked_count local config files"
    else
      fail_check "gitleaks reported possible leaks in local config files"
    fi
  elif gitleaks dir --follow-symlinks --redact --no-banner "$scan_root"; then
    ok "gitleaks found no leaks in $linked_count local config files"
  else
    fail_check "gitleaks reported possible leaks in local config files"
  fi

  rm -rf "$scan_root"
}

find_matching_files() {
  local base="$1"
  shift

  if [ -d "$base" ]; then
    find "$base" "$@" -print 2>/dev/null || true
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --expected-admin-users)
      expected_admin_users="${2:-}"
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

section "default shell secret boundary"

if [ -z "${OP_SERVICE_ACCOUNT_TOKEN+x}" ]; then
  ok "current shell does not export OP_SERVICE_ACCOUNT_TOKEN"
else
  fail_check "current shell exports OP_SERVICE_ACCOUNT_TOKEN"
fi

if [ "$json_output" -eq 1 ]; then
  zsh_login_has_no_token="$(zsh -lic 'test -z "${OP_SERVICE_ACCOUNT_TOKEN+x}"' >/dev/null 2>&1; printf '%s' "$?")"
elif zsh -lic 'test -z "${OP_SERVICE_ACCOUNT_TOKEN+x}"'; then
  zsh_login_has_no_token=0
else
  zsh_login_has_no_token=1
fi

if [ "$zsh_login_has_no_token" = "0" ]; then
  ok "login shell does not export OP_SERVICE_ACCOUNT_TOKEN"
else
  fail_check "login shell exports OP_SERVICE_ACCOUNT_TOKEN"
fi

section "devbox-only state"

devbox_token_file="/var/db/uinaf/devbox-secrets/$USER/op-sa-token"
devbox_env_file="/var/db/uinaf/devbox-env/$USER/openclaw.env"

if [ -e "$devbox_token_file" ]; then
  fail_check "personal setup has devbox service token path: $devbox_token_file"
else
  ok "no devbox service token path for $USER"
fi

if [ -e "$devbox_env_file" ]; then
  fail_check "personal setup has generated devbox env path: $devbox_env_file"
else
  ok "no generated devbox env path for $USER"
fi

section "local config file modes"

check_mode_any "$HOME/.gitconfig.local" 600
check_mode_any "$HOME/.ssh/config.local" 600
check_mode_any "$HOME/.codex/config.toml" 600

section "local secret scan"

op_reference_pattern='op://'

scan_files_with_gitleaks < <(
  {
    find_matching_files "$HOME/.aws" -maxdepth 1 -type f -name 'credentials'
    find_matching_files "$HOME/.docker" -maxdepth 1 -type f -name 'config.json'
    find_matching_files "$HOME" -maxdepth 1 -type f \( -name '.zsh_history' -o -name '.bash_history' -o -name '.zshenv*' -o -name '.zprofile*' -o -name '.zshrc*' -o -name '.gitconfig*' -o -name '.netrc' -o -name '.git-credentials' \)
    find_matching_files "$HOME/.ssh" -maxdepth 1 -type f \( -name 'config' -o -name 'config.*' \)
    find_matching_files "$HOME/Library/LaunchAgents" -maxdepth 1 -type f -name '*.plist'
  } | sort -u
)

while IFS= read -r path; do
  [ -n "$path" ] || continue
  check_pattern_absent "$path" "$op_reference_pattern" "1Password item references" warn
done < <(
  {
    find_matching_files "$HOME" -maxdepth 1 -type f \( -name '.zsh_history' -o -name '.bash_history' -o -name '.zshenv*' -o -name '.zprofile*' -o -name '.zshrc*' -o -name '.gitconfig*' -o -name '.netrc' -o -name '.git-credentials' \)
    find_matching_files "$HOME/.ssh" -maxdepth 1 -type f \( -name 'config' -o -name 'config.*' \)
    find_matching_files "$HOME/Library/LaunchAgents" -maxdepth 1 -type f -name '*.plist'
  } | sort -u
)

if [ -e "$HOME/.docker/config.json" ]; then
  check_pattern_absent "$HOME/.docker/config.json" '"auth"[[:space:]]*:' "inline Docker auth material" fail
fi

section "Git and GitHub identity"

git_name="$(git config --get user.name 2>/dev/null || true)"
git_email="$(git config --get user.email 2>/dev/null || true)"
git_signing_key="$(git config --get user.signingkey 2>/dev/null || true)"
git_gpgsign="$(git config --get commit.gpgsign 2>/dev/null || true)"

if [ -n "$git_name" ] && [ -n "$git_email" ]; then
  ok "git identity configured for $git_name <$git_email>"
else
  warn "git identity is incomplete"
fi

if [ -n "$git_signing_key" ]; then
  ok "git signing key configured"
else
  warn "git signing key is not configured"
fi

if [ "$git_gpgsign" = "true" ]; then
  ok "git commit signing enabled"
else
  warn "git commit signing is not enabled"
fi

if command -v gh >/dev/null 2>&1; then
  if gh auth status -h github.com >/dev/null 2>&1; then
    ok "gh auth works for github.com"
  else
    fail_check "gh auth is not working for github.com"
  fi
else
  fail_check "gh is missing"
fi

section "SSH key file permissions"

if [ -d "$HOME/.ssh" ]; then
  while IFS= read -r key_path; do
    [ -n "$key_path" ] || continue
    key_mode="$(mode_of "$key_path")"
    if [ $((8#$key_mode & 0077)) -eq 0 ]; then
      ok "$key_path mode $key_mode"
    else
      fail_check "$key_path mode $key_mode is group/world accessible"
    fi
  done < <(find "$HOME/.ssh" -maxdepth 1 -type f ! -name '*.pub' ! -name 'known_hosts*' ! -name 'config' -print 2>/dev/null | sort)
else
  warn "missing $HOME/.ssh"
fi

section "admin group"

if admin_members="$(dscl . -read /Groups/admin GroupMembership 2>/dev/null | cut -d: -f2- | xargs 2>/dev/null)"; then
  if [ -n "$expected_admin_users" ]; then
    expected_sorted="$(printf '%s\n' "$expected_admin_users" | tr ' ' '\n' | sed '/^$/d' | sort | xargs)"
    actual_sorted="$(printf '%s\n' "$admin_members" | tr ' ' '\n' | sed '/^$/d' | sort | xargs)"
    if [ "$actual_sorted" = "$expected_sorted" ]; then
      ok "admin group matches expected users"
    else
      fail_check "admin group is [$actual_sorted], expected [$expected_sorted]"
    fi
  else
    warn "admin users: $admin_members; set UINAF_EXPECTED_ADMIN_USERS to enforce"
  fi
else
  warn "could not read admin group"
fi

section "Tailscale"

if command -v tailscale >/dev/null 2>&1; then
  if tailscale status --peers=false >/dev/null 2>&1; then
    ok "tailscale status works"
  else
    warn "tailscale status failed"
  fi
else
  warn "tailscale CLI is missing"
fi

if [ "$json_output" -eq 1 ]; then
  print_json_summary
else
  printf '\npersonal security audit summary: %s failed, %s warnings\n' "$fail_count" "$warn_count"
fi

if [ "$fail_count" -gt 0 ]; then
  exit 1
fi
