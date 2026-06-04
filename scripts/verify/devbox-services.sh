#!/usr/bin/env bash
set -euo pipefail

config_path="${UINAF_DEVBOX_CONFIG:-$HOME/.config/uinaf/devbox.env}"
devbox_user="${UINAF_DEVBOX_USER:-$USER}"
process_compose_enabled="${UINAF_PROCESS_COMPOSE_ENABLED:-1}"
process_compose_port="${UINAF_PROCESS_COMPOSE_PORT:-9191}"
process_compose_socket="${UINAF_PROCESS_COMPOSE_SOCKET:-}"

usage() {
  cat <<'USAGE'
Usage:
  scripts/verify/devbox-services.sh

Checks devbox supervisor, Infisical CLI availability, and default-shell token
boundaries for the current Unix user. Configure process-compose through
~/.config/uinaf/devbox.env or the
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
  else
    printf 'warn missing optional %s; using defaults\n' "$config_path"
  fi
}

check_no_default_secret_exports() {
  section "default shell secret boundary"

  if zsh -lic 'test -z "${INFISICAL_TOKEN+x}"'; then
    printf 'ok INFISICAL_TOKEN is not exported by default login shell\n'
  else
    fail "INFISICAL_TOKEN is exported by the default login shell"
  fi
}

check_infisical() {
  section "infisical"

  command -v infisical >/dev/null || fail "missing infisical"
  infisical --version >/dev/null || fail "infisical CLI does not run"
  printf 'ok infisical installed\n'
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

check_config
check_no_default_secret_exports
check_infisical
check_process_compose

printf '\ndevbox verification ok\n'
