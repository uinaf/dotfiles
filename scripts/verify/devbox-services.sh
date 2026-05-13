#!/usr/bin/env bash
set -euo pipefail

config_path="${UINAF_DEVBOX_CONFIG:-$HOME/.config/uinaf/devbox.env}"
devbox_user="${UINAF_DEVBOX_USER:-$USER}"
process_compose_enabled="${UINAF_PROCESS_COMPOSE_ENABLED:-1}"
process_compose_port="${UINAF_PROCESS_COMPOSE_PORT:-9191}"
process_compose_socket="${UINAF_PROCESS_COMPOSE_SOCKET:-}"
token_file="${UINAF_OP_SERVICE_ACCOUNT_TOKEN_FILE:-/var/db/uinaf/devbox-secrets/$devbox_user/op-sa-token}"
openclaw_env_file="${UINAF_OPENCLAW_ENV_FILE:-/var/db/uinaf/devbox-env/$devbox_user/openclaw.env}"

usage() {
  cat <<'USAGE'
Usage:
  scripts/verify/devbox-services.sh

Checks devbox supervisor, secret-file, and 1Password-token boundaries for the
current Unix user. Configure paths through ~/.config/uinaf/devbox.env or the
UINAF_DEVBOX_* environment variables.
USAGE
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

if [ "$#" -gt 0 ]; then
  printf 'unknown argument: %s\n' "$1" >&2
  usage >&2
  exit 2
fi

section() {
  printf '\n## %s\n' "$1"
}

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

mode_of() {
  stat -f '%Lp' "$1"
}

check_mode() {
  local path="$1"
  local expected="$2"
  local mode

  [ -e "$path" ] || fail "missing $path"
  mode="$(mode_of "$path")"
  [ "$mode" = "$expected" ] || fail "$path mode is $mode, expected $expected"
  printf 'ok %s mode %s\n' "$path" "$expected"
}

check_mode_any() {
  local path="$1"
  shift
  local mode
  local expected

  [ -e "$path" ] || fail "missing $path"
  mode="$(mode_of "$path")"
  for expected in "$@"; do
    if [ "$mode" = "$expected" ]; then
      printf 'ok %s mode %s\n' "$path" "$mode"
      return
    fi
  done
  fail "$path mode is $mode, expected one of: $*"
}

check_config() {
  section "local devbox config"

  if [ -e "$config_path" ]; then
    check_mode "$config_path" 600
    # shellcheck disable=SC1090
    . "$config_path"
    devbox_user="${UINAF_DEVBOX_USER:-$devbox_user}"
    process_compose_enabled="${UINAF_PROCESS_COMPOSE_ENABLED:-$process_compose_enabled}"
    process_compose_port="${UINAF_PROCESS_COMPOSE_PORT:-$process_compose_port}"
    process_compose_socket="${UINAF_PROCESS_COMPOSE_SOCKET:-$process_compose_socket}"
    token_file="${UINAF_OP_SERVICE_ACCOUNT_TOKEN_FILE:-$token_file}"
    openclaw_env_file="${UINAF_OPENCLAW_ENV_FILE:-$openclaw_env_file}"
  else
    printf 'warn missing optional %s; using defaults\n' "$config_path"
  fi
}

check_no_default_token_export() {
  section "default shell secret boundary"

  if zsh -lic 'test -z "${OP_SERVICE_ACCOUNT_TOKEN+x}"'; then
    printf 'ok OP_SERVICE_ACCOUNT_TOKEN is not exported by default login shell\n'
  else
    fail "OP_SERVICE_ACCOUNT_TOKEN is exported by the default login shell"
  fi
}

check_process_compose() {
  section "process-compose"

  if [ "$process_compose_enabled" = "0" ]; then
    printf 'ok process-compose check disabled for this devbox user\n'
    return
  fi

  command -v process-compose >/dev/null || fail "missing process-compose"
  printf 'ok process-compose installed\n'

  if [ -n "$process_compose_socket" ]; then
    if process-compose --use-uds --unix-socket "$process_compose_socket" process list >/dev/null 2>&1; then
      printf 'ok process-compose responds on socket %s\n' "$process_compose_socket"
    else
      fail "process-compose is not responding on socket $process_compose_socket"
    fi
  elif process-compose --port "$process_compose_port" process list >/dev/null 2>&1; then
    printf 'ok process-compose responds on port %s\n' "$process_compose_port"
  else
    fail "process-compose is not responding on port $process_compose_port"
  fi
}

check_secret_files() {
  local env_dir

  section "secret file modes"

  if [ -e "$openclaw_env_file" ]; then
    env_dir="$(dirname "$openclaw_env_file")"
    check_mode_any "$env_dir" 700 711
    check_mode_any "$openclaw_env_file" 400 600
    if grep -q '^OP_SERVICE_ACCOUNT_TOKEN=' "$openclaw_env_file"; then
      fail "$openclaw_env_file must not contain OP_SERVICE_ACCOUNT_TOKEN"
    fi
    printf 'ok no OP service token in generated env\n'
  else
    printf 'warn missing %s; skip OpenClaw env mode check\n' "$openclaw_env_file"
  fi
}

check_service_token_file() {
  section "1Password service account token file"

  if [ "$(id -u)" -ne 0 ] && [ ! -e "$token_file" ]; then
    printf 'warn %s is not visible to this user; run with sudo to verify root-owned token storage\n' "$token_file"
    return
  fi

  if [ -e "$token_file" ]; then
    check_mode_any "$token_file" 400 600
    if [ "$(stat -f '%Su' "$token_file")" = "root" ]; then
      printf 'ok token file is root-owned\n'
    else
      fail "$token_file must be root-owned"
    fi
  else
    fail "missing $token_file"
  fi
}

check_config
check_no_default_token_export
check_process_compose
check_secret_files
check_service_token_file

printf '\ndevbox verification ok\n'
