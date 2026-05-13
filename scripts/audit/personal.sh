#!/usr/bin/env bash
set -euo pipefail

json_output=0
warn_count=0
fail_count=0
secret_scan_count=0
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck source=scripts/lib/audit.sh
. "$repo_root/scripts/lib/audit.sh"

usage() {
  cat <<'USAGE'
Usage:
  scripts/audit/personal.sh [options]

Runs a non-destructive personal/non-devbox drift audit for the current Unix user.

Options:
  --json                        print a machine-readable summary instead of prose
  -h, --help

The script checks local secret boundaries, Git/GitHub identity state, SSH key
permissions, Tailscale state, and whether devbox-only service-account state has
drifted onto a personal setup. It does not print secret values.
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
  json_string "personal-security"
  printf ',"status":'
  json_string "$status"
  printf ',"failed":%s,"warnings":%s,"user":' "$fail_count" "$warn_count"
  json_string "$USER"
  printf ',"secret_scan_count":%s' "$secret_scan_count"
  printf '}\n'
}

emit_personal_secret_scan_paths() {
  emit_home_dotfiles
  emit_path_if_exists "$HOME/.aws"
  emit_path_if_exists "$HOME/.docker"
  emit_path_if_exists "$HOME/.bash_sessions"
  emit_path_if_exists "$HOME/.zsh_sessions"
  emit_path_if_exists "$HOME/Library/LaunchAgents"
  find_matching_files "$HOME/.ssh" -maxdepth 1 -type f -name 'config*'
}

emit_personal_reference_scan_files() {
  emit_home_dotfiles
  find_matching_files "$HOME/.ssh" -maxdepth 1 -type f -name 'config*'
  find_matching_files "$HOME/Library/LaunchAgents" -type f
}

while [ "$#" -gt 0 ]; do
  case "$1" in
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

load_uinaf_audit_policy

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

check_mode_any warn "$HOME/.gitconfig.local" 600
check_mode_any warn "$HOME/.ssh/config.local" 600
check_mode_any warn "$HOME/.codex/config.toml" 600

section "local secret scan"

op_reference_pattern='op://'

scan_files_for_secrets < <(
  emit_personal_secret_scan_paths | sort -u
)

while IFS= read -r path; do
  [ -n "$path" ] || continue
  check_pattern_absent "$path" "$op_reference_pattern" "1Password item references" warn
done < <(
  emit_personal_reference_scan_files | sort -u
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
    warn_on_broad_gh_scopes
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

section "Codex log size"

if [ -d "$HOME/.codex" ]; then
  while IFS= read -r log_path; do
    [ -n "$log_path" ] || continue
    log_size="$(stat -f '%z' "$log_path" 2>/dev/null || printf 0)"
    if [ "$log_size" -ge 524288000 ]; then
      fail_check "$log_path is larger than 500 MB"
    elif [ "$log_size" -ge 209715200 ]; then
      warn "$log_path is larger than 200 MB"
    else
      ok "$log_path size is under 200 MB"
    fi
  done < <(find "$HOME/.codex" -maxdepth 1 -type f \( -name 'logs*.sqlite' -o -name 'logs*.sqlite-wal' \) -print 2>/dev/null | sort)
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
