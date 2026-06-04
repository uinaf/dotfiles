#!/usr/bin/env bash
set -euo pipefail

config_path="${UINAF_DEVBOX_CONFIG:-$HOME/.config/uinaf/devbox.env}"
devbox_user="${UINAF_DEVBOX_USER:-$USER}"
process_compose_enabled="${PROCESS_COMPOSE_ENABLED:-1}"
process_compose_port="${PROCESS_COMPOSE_PORT:-9191}"
process_compose_socket="${PROCESS_COMPOSE_SOCKET:-}"
infisical_domain="${INFISICAL_DOMAIN:-https://eu.infisical.com/api}"
infisical_project_id="${INFISICAL_PROJECT_ID:-}"
infisical_env="${INFISICAL_ENV:-dev}"
infisical_secret_path="${INFISICAL_SECRET_PATH:-}"

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

owner_of() {
  stat -f '%Su' "$1"
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
    process_compose_enabled="${PROCESS_COMPOSE_ENABLED:-$process_compose_enabled}"
    process_compose_port="${PROCESS_COMPOSE_PORT:-$process_compose_port}"
    process_compose_socket="${PROCESS_COMPOSE_SOCKET:-$process_compose_socket}"
    infisical_domain="${INFISICAL_DOMAIN:-$infisical_domain}"
    infisical_project_id="${INFISICAL_PROJECT_ID:-$infisical_project_id}"
    infisical_env="${INFISICAL_ENV:-$infisical_env}"
    infisical_secret_path="${INFISICAL_SECRET_PATH:-$infisical_secret_path}"
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
  local status_json
  local status_exit=0
  local access_token

  command -v infisical >/dev/null || fail "missing infisical"
  infisical --version >/dev/null || fail "infisical CLI does not run"
  printf 'ok infisical installed\n'

  set +e
  status_json="$(infisical login status --domain "$infisical_domain" --json 2>/dev/null)"
  status_exit=$?
  set -e
  if [ -z "$status_json" ] || ! printf '%s\n' "$status_json" | grep -q '"sessions"'; then
    fail "could not inspect Infisical login status"
  fi
  if printf '%s\n' "$status_json" \
    | tr -d '\n' \
    | grep -Eq '"principalType"[[:space:]]*:[[:space:]]*"user"[^}]*"status"[[:space:]]*:[[:space:]]*"authenticated"|"status"[[:space:]]*:[[:space:]]*"authenticated"[^}]*"principalType"[[:space:]]*:[[:space:]]*"user"'; then
    fail "Infisical CLI has an authenticated human user session"
  fi
  if [ "$status_exit" -eq 0 ]; then
    printf 'ok no authenticated Infisical human user session\n'
  else
    printf 'ok no authenticated Infisical human user session; status returned nonzero for inactive/expired session\n'
  fi

  if [ -z "${INFISICAL_CLIENT_ID:-}" ] \
    || [ -z "${INFISICAL_CLIENT_SECRET:-}" ] \
    || [ -z "$infisical_project_id" ] \
    || [ -z "$infisical_secret_path" ]; then
    printf 'warn skipped Infisical machine identity path proof; set INFISICAL_CLIENT_ID, INFISICAL_CLIENT_SECRET, INFISICAL_PROJECT_ID, and INFISICAL_SECRET_PATH in the current shell\n'
    return
  fi

  access_token="$(
    infisical login \
      --domain "$infisical_domain" \
      --method=universal-auth \
      --client-id "$INFISICAL_CLIENT_ID" \
      --client-secret "$INFISICAL_CLIENT_SECRET" \
      --plain \
      --silent
  )" || fail "could not mint Infisical machine identity token"

  infisical secrets get \
    --domain "$infisical_domain" \
    --token "$access_token" \
    --projectId "$infisical_project_id" \
    --env "$infisical_env" \
    --path "$infisical_secret_path" \
    --output json \
    --silent >/dev/null \
    || fail "Infisical machine identity cannot read $infisical_secret_path"
  printf 'ok Infisical machine identity can read %s\n' "$infisical_secret_path"
}

check_openclaw_runtime_env() {
  local env_file="$HOME/.openclaw/.env"
  local env_owner

  section "OpenClaw runtime env boundary"

  if [ ! -e "$env_file" ]; then
    printf 'warn missing optional %s\n' "$env_file"
    return
  fi

  [ ! -L "$env_file" ] || fail "$env_file must be a direct file, not a symlink"
  check_mode "$env_file" 600
  env_owner="$(owner_of "$env_file")"
  [ "$env_owner" = "$devbox_user" ] || fail "$env_file owner is $env_owner, expected $devbox_user"
  printf 'ok %s owner %s\n' "$env_file" "$env_owner"
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
check_openclaw_runtime_env
check_process_compose

printf '\ndevbox verification ok\n'
