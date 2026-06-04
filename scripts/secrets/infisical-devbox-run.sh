#!/usr/bin/env bash
set -euo pipefail

config_path="${INFISICAL_DEVBOX_CONFIG:-$HOME/.config/uinaf/devbox.env}"
machine_config_path="${INFISICAL_MACHINE_CONFIG:-$HOME/.config/uinaf/infisical-machine.env}"

usage() {
  cat <<'USAGE'
Usage:
  scripts/secrets/infisical-devbox-run.sh -- <command> [args...]

Loads owner-only devbox Infisical machine identity config, mints a short-lived
machine token, then runs the command with INFISICAL_TOKEN in that process only.
USAGE
}

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

mode_of() {
  stat -f '%Lp' "$1"
}

load_required_config() {
  local path="$1"

  [ -e "$path" ] || fail "missing $path"
  [ "$(mode_of "$path")" = "600" ] \
    || fail "$path mode is $(mode_of "$path"), expected 600"
  # shellcheck disable=SC1090
  . "$path"
}

check_no_human_infisical_session() {
  local domain="$1"
  local status_json

  set +e
  status_json="$(infisical login status --domain "$domain" --json 2>/dev/null)"
  set -e

  [ -n "$status_json" ] || fail "could not inspect Infisical login status"
  printf '%s\n' "$status_json" | grep -q '"sessions"' \
    || fail "could not inspect Infisical login status"

  if printf '%s\n' "$status_json" \
    | tr -d '\n' \
    | grep -Eq '"principalType"[[:space:]]*:[[:space:]]*"user"[^}]*"status"[[:space:]]*:[[:space:]]*"authenticated"|"status"[[:space:]]*:[[:space:]]*"authenticated"[^}]*"principalType"[[:space:]]*:[[:space:]]*"user"'; then
    fail "Infisical CLI has an authenticated human user session"
  fi
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

if [ "${1:-}" = "--" ]; then
  shift
fi

[ "$#" -gt 0 ] || {
  usage >&2
  exit 2
}

override_infisical_domain="${INFISICAL_DOMAIN:-}"
override_infisical_project_id="${INFISICAL_PROJECT_ID:-}"
override_infisical_env="${INFISICAL_ENV:-}"
override_infisical_secret_path="${INFISICAL_SECRET_PATH:-}"

command -v infisical >/dev/null || fail "missing infisical"
infisical --version >/dev/null || fail "infisical CLI does not run"

load_required_config "$config_path"
load_required_config "$machine_config_path"

if [ -n "$override_infisical_domain" ]; then
  INFISICAL_DOMAIN="$override_infisical_domain"
fi
if [ -n "$override_infisical_project_id" ]; then
  INFISICAL_PROJECT_ID="$override_infisical_project_id"
fi
if [ -n "$override_infisical_env" ]; then
  INFISICAL_ENV="$override_infisical_env"
fi
if [ -n "$override_infisical_secret_path" ]; then
  INFISICAL_SECRET_PATH="$override_infisical_secret_path"
fi

: "${INFISICAL_DOMAIN:=https://eu.infisical.com/api}"
: "${INFISICAL_ENV:=dev}"

[ -n "${INFISICAL_PROJECT_ID:-}" ] || fail "INFISICAL_PROJECT_ID is required in $config_path"
[ -n "${INFISICAL_SECRET_PATH:-}" ] || fail "INFISICAL_SECRET_PATH is required in $config_path"
[ -n "${INFISICAL_CLIENT_ID:-}" ] || fail "INFISICAL_CLIENT_ID is required in $machine_config_path"
[ -n "${INFISICAL_CLIENT_SECRET:-}" ] || fail "INFISICAL_CLIENT_SECRET is required in $machine_config_path"

check_no_human_infisical_session "$INFISICAL_DOMAIN"

infisical_token="$(
  infisical login \
    --domain "$INFISICAL_DOMAIN" \
    --method=universal-auth \
    --client-id "$INFISICAL_CLIENT_ID" \
    --client-secret "$INFISICAL_CLIENT_SECRET" \
    --plain \
    --silent
)" || fail "could not mint Infisical machine identity token"

trap 'unset infisical_token INFISICAL_TOKEN INFISICAL_CLIENT_ID INFISICAL_CLIENT_SECRET' EXIT
set +e
env \
  -u INFISICAL_CLIENT_ID \
  -u INFISICAL_CLIENT_SECRET \
  INFISICAL_TOKEN="$infisical_token" \
  INFISICAL_DOMAIN="$INFISICAL_DOMAIN" \
  INFISICAL_PROJECT_ID="$INFISICAL_PROJECT_ID" \
  INFISICAL_ENV="$INFISICAL_ENV" \
  INFISICAL_SECRET_PATH="$INFISICAL_SECRET_PATH" \
  "$@"
status=$?
set -e

exit "$status"
