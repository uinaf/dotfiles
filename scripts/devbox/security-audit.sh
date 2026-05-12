#!/usr/bin/env bash
set -euo pipefail

config_path="${UINAF_DEVBOX_CONFIG:-$HOME/.config/uinaf/devbox.env}"
devbox_user="${UINAF_DEVBOX_USER:-$USER}"
process_compose_enabled="${UINAF_PROCESS_COMPOSE_ENABLED:-1}"
process_compose_port="${UINAF_PROCESS_COMPOSE_PORT:-9191}"
process_compose_socket="${UINAF_PROCESS_COMPOSE_SOCKET:-}"
token_file="${UINAF_OP_SERVICE_ACCOUNT_TOKEN_FILE:-/var/db/uinaf/devbox-secrets/$devbox_user/op-sa-token}"
openclaw_env_file="${UINAF_OPENCLAW_ENV_FILE:-/var/db/uinaf/devbox-env/$devbox_user/openclaw.env}"
openclaw_env_link="${UINAF_OPENCLAW_ENV_LINK:-$HOME/.openclaw/.env}"
expected_admin_users="${UINAF_EXPECTED_ADMIN_USERS:-}"
warn_count=0
fail_count=0

usage() {
  cat <<'USAGE'
Usage:
  scripts/devbox/security-audit.sh [options]

Runs a non-destructive devbox drift audit for the current Unix user.

Options:
  --config PATH                 local devbox config, default: ~/.config/uinaf/devbox.env
  --expected-admin-users LIST   space-separated admin users expected on this Mac
  -h, --help

The script checks secret boundaries, process-compose isolation, Git/GitHub
identity state, SSH key permissions, and common stale secret backup locations.
It does not print secret values.
USAGE
}

section() {
  printf '\n## %s\n' "$1"
}

ok() {
  printf 'ok %s\n' "$1"
}

warn() {
  warn_count=$((warn_count + 1))
  printf 'warn %s\n' "$1" >&2
}

fail_check() {
  fail_count=$((fail_count + 1))
  printf 'FAILED: %s\n' "$1" >&2
}

mode_of() {
  stat -f '%Lp' "$1"
}

owner_of() {
  stat -f '%Su' "$1"
}

check_mode_any() {
  local path="$1"
  shift
  local mode
  local expected

  if [ ! -e "$path" ]; then
    fail_check "missing $path"
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

check_not_secret_pattern() {
  local path="$1"
  local pattern="$2"
  local label="$3"

  if [ ! -r "$path" ]; then
    warn "cannot read $path for $label"
    return
  fi

  if grep -Eq "$pattern" "$path"; then
    fail_check "$path contains $label"
  else
    ok "$path does not contain $label"
  fi
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
    --config)
      config_path="${2:-}"
      shift 2
      ;;
    --expected-admin-users)
      expected_admin_users="${2:-}"
      shift 2
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

section "local devbox config"

if [ -e "$config_path" ]; then
  check_mode_any "$config_path" 600
  # shellcheck disable=SC1090
  . "$config_path"
  devbox_user="${UINAF_DEVBOX_USER:-$devbox_user}"
  process_compose_enabled="${UINAF_PROCESS_COMPOSE_ENABLED:-$process_compose_enabled}"
  process_compose_port="${UINAF_PROCESS_COMPOSE_PORT:-$process_compose_port}"
  process_compose_socket="${UINAF_PROCESS_COMPOSE_SOCKET:-$process_compose_socket}"
  token_file="${UINAF_OP_SERVICE_ACCOUNT_TOKEN_FILE:-$token_file}"
  openclaw_env_file="${UINAF_OPENCLAW_ENV_FILE:-$openclaw_env_file}"
  openclaw_env_link="${UINAF_OPENCLAW_ENV_LINK:-$openclaw_env_link}"
  expected_admin_users="${UINAF_EXPECTED_ADMIN_USERS:-$expected_admin_users}"
else
  warn "missing optional $config_path; using defaults"
fi

if [ "$devbox_user" != "$USER" ]; then
  warn "UINAF_DEVBOX_USER is $devbox_user but current user is $USER"
else
  ok "devbox user matches current user: $devbox_user"
fi

section "default shell secret boundary"

if [ -z "${OP_SERVICE_ACCOUNT_TOKEN+x}" ]; then
  ok "current shell does not export OP_SERVICE_ACCOUNT_TOKEN"
else
  fail_check "current shell exports OP_SERVICE_ACCOUNT_TOKEN"
fi

if zsh -lic 'test -z "${OP_SERVICE_ACCOUNT_TOKEN+x}"'; then
  ok "login shell does not export OP_SERVICE_ACCOUNT_TOKEN"
else
  fail_check "login shell exports OP_SERVICE_ACCOUNT_TOKEN"
fi

section "1Password service account token file"

if [ "$(id -u)" -ne 0 ] && [ ! -e "$token_file" ]; then
  warn "$token_file is not visible to this user; run with sudo to verify root-owned token storage"
else
  check_mode_any "$token_file" 400 600
  if [ -e "$token_file" ]; then
    if [ "$(owner_of "$token_file")" = "root" ]; then
      ok "$token_file is root-owned"
    else
      fail_check "$token_file must be root-owned"
    fi
  fi
fi

section "generated runtime env"

if [ -e "$openclaw_env_file" ]; then
  env_dir="$(dirname "$openclaw_env_file")"
  check_mode_any "$env_dir" 700 711
  check_mode_any "$openclaw_env_file" 400 600

  if [ -L "$openclaw_env_file" ]; then
    fail_check "$openclaw_env_file must not be a symlink"
  fi

  env_owner="$(owner_of "$openclaw_env_file")"
  if [ "$env_owner" = "$devbox_user" ]; then
    ok "$openclaw_env_file owner $env_owner"
  else
    fail_check "$openclaw_env_file owner is $env_owner, expected $devbox_user"
  fi

  check_not_secret_pattern "$openclaw_env_file" '^OP_SERVICE_ACCOUNT_TOKEN=' "OP service account token"
else
  warn "missing $openclaw_env_file"
fi

if [ -e "$openclaw_env_link" ] || [ -L "$openclaw_env_link" ]; then
  if [ -L "$openclaw_env_link" ]; then
    link_target="$(readlink "$openclaw_env_link")"
    if [ "$link_target" = "$openclaw_env_file" ]; then
      ok "$openclaw_env_link points to generated env"
    else
      fail_check "$openclaw_env_link points to $link_target, expected $openclaw_env_file"
    fi
  else
    fail_check "$openclaw_env_link should be a symlink to the generated env"
  fi
else
  warn "missing compatibility env link $openclaw_env_link"
fi

section "process-compose boundary"

if [ "$process_compose_enabled" = "0" ]; then
  ok "process-compose check disabled"
elif ! command -v process-compose >/dev/null 2>&1; then
  fail_check "process-compose is missing"
elif [ -n "$process_compose_socket" ]; then
  if process-compose --use-uds --unix-socket "$process_compose_socket" process list >/dev/null 2>&1; then
    ok "process-compose responds on socket $process_compose_socket"
  else
    fail_check "process-compose is not responding on socket $process_compose_socket"
  fi
else
  warn "using process-compose TCP port; prefer UINAF_PROCESS_COMPOSE_SOCKET"
  if process-compose --port "$process_compose_port" process list >/dev/null 2>&1; then
    ok "process-compose responds on port $process_compose_port"
  else
    fail_check "process-compose is not responding on port $process_compose_port"
  fi
fi

section "local config secret scan"

secret_pattern='OP_SERVICE_ACCOUNT_TOKEN=|op://|BEGIN OPENSSH PRIVATE KEY|BEGIN RSA PRIVATE KEY'

while IFS= read -r path; do
  [ -n "$path" ] || continue
  check_not_secret_pattern "$path" "$secret_pattern" "secret-looking material"
done < <(
  {
    find_matching_files "$HOME/.config/process-compose" -type f \( -name '*.yaml' -o -name '*.yml' -o -name '*.bak' \)
    find_matching_files "$HOME/.openclaw" -type f \( -name '*.json' -o -name '*.env' -o -name '*.bak' -o -name '*.last-good' \)
    find_matching_files "$HOME" -maxdepth 1 -type f \( -name '.zsh_history' -o -name '.bash_history' -o -name '.zshenv*' -o -name '.zprofile*' -o -name '.zshrc*' -o -name '.gitconfig*' \)
    find_matching_files "$HOME/.ssh" -maxdepth 1 -type f \( -name 'config' -o -name 'config.*' \)
    find_matching_files /Library/LaunchDaemons -maxdepth 1 -type f -name 'com.uinaf.*.plist'
    find_matching_files "$HOME/Library/LaunchAgents" -maxdepth 1 -type f -name 'com.uinaf.*.plist'
  } | sort -u
)

section "Git and GitHub identity"

git_name="$(git config --global --get user.name 2>/dev/null || true)"
git_email="$(git config --global --get user.email 2>/dev/null || true)"
git_signing_key="$(git config --global --get user.signingkey 2>/dev/null || true)"
git_gpgsign="$(git config --global --get commit.gpgsign 2>/dev/null || true)"

[ -n "$git_name" ] || fail_check "missing global git user.name"
[ -n "$git_email" ] || fail_check "missing global git user.email"
[ -n "$git_signing_key" ] || fail_check "missing global git user.signingkey"

if [ -n "$git_name" ] && [ -n "$git_email" ]; then
  ok "git identity configured for $git_name <$git_email>"
fi

if [ "$git_gpgsign" = "true" ]; then
  ok "git commit signing enabled"
else
  fail_check "git commit signing is not enabled"
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
    fail_check "tailscale status failed"
  fi
else
  fail_check "tailscale is missing"
fi

printf '\ndevbox security audit summary: %s failed, %s warnings\n' "$fail_count" "$warn_count"

if [ "$fail_count" -gt 0 ]; then
  exit 1
fi
