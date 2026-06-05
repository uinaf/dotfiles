#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
config_path="${DEVBOX_CONFIG:-$HOME/.config/uinaf/devbox.env}"
machine_config_path="${INFISICAL_MACHINE_CONFIG:-$HOME/.config/uinaf/infisical-machine.env}"

# shellcheck source=scripts/lib/infisical.sh
. "$repo_root/scripts/lib/infisical.sh"

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
  infisical_file_mode "$1"
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

  infisical_capture_login_status "$domain"
  [ -n "$INFISICAL_LOGIN_STATUS_JSON" ] || fail "could not inspect Infisical login status"
  infisical_status_has_sessions \
    || fail "could not inspect Infisical login status"
  if infisical_status_has_authenticated_human_user; then
    fail "Infisical CLI has an authenticated human user session"
  fi
  if [ "$INFISICAL_LOGIN_STATUS_EXIT" -ne 0 ] && ! infisical_status_has_only_inactive_sessions; then
    fail "could not verify Infisical login status session state"
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
unset INFISICAL_CLIENT_ID INFISICAL_CLIENT_SECRET
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
[ -n "${INFISICAL_CLIENT_ID:-}" ] || fail "INFISICAL_CLIENT_ID is required in $machine_config_path"
[ -n "${INFISICAL_CLIENT_SECRET:-}" ] || fail "INFISICAL_CLIENT_SECRET is required in $machine_config_path"

check_no_human_infisical_session "$INFISICAL_DOMAIN"

infisical_token="$(infisical_mint_machine_token "$INFISICAL_DOMAIN" "$INFISICAL_CLIENT_ID" "$INFISICAL_CLIENT_SECRET")" \
  || fail "could not mint Infisical machine identity token"

trap 'unset infisical_token INFISICAL_TOKEN INFISICAL_CLIENT_ID INFISICAL_CLIENT_SECRET' EXIT
set +e
env \
  -u INFISICAL_CLIENT_ID \
  -u INFISICAL_CLIENT_SECRET \
  INFISICAL_TOKEN="$infisical_token" \
  INFISICAL_DOMAIN="$INFISICAL_DOMAIN" \
  INFISICAL_PROJECT_ID="$INFISICAL_PROJECT_ID" \
  INFISICAL_ENV="$INFISICAL_ENV" \
  "$@"
status=$?
set -e

exit "$status"
