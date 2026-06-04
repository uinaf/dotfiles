#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
config_path="${UINAF_DEVBOX_CONFIG:-$HOME/.config/uinaf/devbox.env}"
machine_config_path="${INFISICAL_MACHINE_CONFIG:-$HOME/.config/uinaf/infisical-machine.env}"

# shellcheck source=scripts/lib/infisical.sh
. "$repo_root/scripts/lib/infisical.sh"

usage() {
  cat <<'USAGE'
Usage:
  scripts/secrets/configure-infisical-devbox.sh

Prompts for Infisical machine identity settings, verifies the machine identity
can read the selected secret path, then writes owner-only local config files.
USAGE
}

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

mode_of() {
  stat -f '%Lp' "$1"
}

quote_assignment() {
  local key="$1"
  local value="$2"
  printf '%s=%q\n' "$key" "$value"
}

prompt_value() {
  local label="$1"
  local default_value="$2"
  local value

  if [ -n "$default_value" ]; then
    printf '%s [%s]: ' "$label" "$default_value" >&2
  else
    printf '%s: ' "$label" >&2
  fi

  IFS= read -r value
  if [ -z "$value" ]; then
    value="$default_value"
  fi
  printf '%s' "$value"
}

prompt_secret() {
  local label="$1"
  local value
  local old_stty

  printf '%s: ' "$label" >&2
  old_stty="$(stty -g)"
  stty -echo
  IFS= read -r value
  stty "$old_stty"
  printf '\n' >&2
  printf '%s' "$value"
}

load_if_present() {
  local path="$1"

  [ -e "$path" ] || return
  if [ "$(mode_of "$path")" != "600" ]; then
    fail "$path mode is $(mode_of "$path"), expected 600"
  fi
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

write_devbox_config() {
  local tmp_path="$1"
  local existing_path="$2"

  if [ -e "$existing_path" ]; then
    grep -Ev '^(INFISICAL_DOMAIN|INFISICAL_PROJECT_ID|INFISICAL_ENV|INFISICAL_SECRET_PATH|INFISICAL_MACHINE_IDENTITY|INFISICAL_CLIENT_ID|INFISICAL_CLIENT_SECRET|INFISICAL_TOKEN)=' "$existing_path" > "$tmp_path" || true
  fi

  {
    quote_assignment INFISICAL_DOMAIN "$infisical_domain"
    quote_assignment INFISICAL_PROJECT_ID "$infisical_project_id"
    quote_assignment INFISICAL_ENV "$infisical_env"
    quote_assignment INFISICAL_SECRET_PATH "$infisical_secret_path"
  } >> "$tmp_path"
}

write_machine_config() {
  local tmp_path="$1"

  {
    quote_assignment INFISICAL_MACHINE_IDENTITY "$infisical_machine_identity"
    quote_assignment INFISICAL_CLIENT_ID "$infisical_client_id"
    quote_assignment INFISICAL_CLIENT_SECRET "$infisical_client_secret"
  } > "$tmp_path"
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

[ -t 0 ] || fail "interactive terminal required"
command -v infisical >/dev/null || fail "missing infisical"
infisical --version >/dev/null || fail "infisical CLI does not run"

load_if_present "$config_path"
unset INFISICAL_MACHINE_IDENTITY INFISICAL_CLIENT_ID INFISICAL_CLIENT_SECRET
load_if_present "$machine_config_path"

infisical_domain="$(prompt_value "Infisical domain" "${INFISICAL_DOMAIN:-https://eu.infisical.com/api}")"
infisical_project_id="$(prompt_value "Infisical project ID" "${INFISICAL_PROJECT_ID:-}")"
infisical_env="$(prompt_value "Infisical env" "${INFISICAL_ENV:-dev}")"
infisical_secret_path="$(prompt_value "Default secret path" "${INFISICAL_SECRET_PATH:-}")"
infisical_machine_identity="$(prompt_value "Machine identity name" "${INFISICAL_MACHINE_IDENTITY:-}")"
infisical_client_id="$(prompt_value "Machine identity client ID" "${INFISICAL_CLIENT_ID:-}")"
infisical_client_secret="$(prompt_secret "Machine identity client secret")"

[ -n "$infisical_domain" ] || fail "Infisical domain is required"
[ -n "$infisical_project_id" ] || fail "Infisical project ID is required"
[ -n "$infisical_env" ] || fail "Infisical env is required"
[ -n "$infisical_secret_path" ] || fail "Default secret path is required"
[ -n "$infisical_client_id" ] || fail "Machine identity client ID is required"
[ -n "$infisical_client_secret" ] || fail "Machine identity client secret is required"

check_no_human_infisical_session "$infisical_domain"

infisical_token="$(infisical_mint_machine_token "$infisical_domain" "$infisical_client_id" "$infisical_client_secret")" \
  || fail "could not mint Infisical machine identity token"

infisical export \
  --domain "$infisical_domain" \
  --token "$infisical_token" \
  --projectId "$infisical_project_id" \
  --env "$infisical_env" \
  --path "$infisical_secret_path" \
  --format json \
  --silent >/dev/null \
  || fail "machine identity cannot read $infisical_secret_path"

config_dir="$(dirname "$config_path")"
machine_config_dir="$(dirname "$machine_config_path")"
mkdir -p "$config_dir"
chmod 700 "$config_dir"
mkdir -p "$machine_config_dir"
chmod 700 "$machine_config_dir"

tmp_config="$(mktemp "${TMPDIR:-/tmp}/uinaf-devbox-env.XXXXXX")"
tmp_machine="$(mktemp "${TMPDIR:-/tmp}/uinaf-infisical-machine.XXXXXX")"
trap 'rm -f "$tmp_config" "$tmp_machine"; unset infisical_token infisical_client_secret' EXIT

write_devbox_config "$tmp_config" "$config_path"
chmod 600 "$tmp_config"
mv "$tmp_config" "$config_path"
chmod 600 "$config_path"

write_machine_config "$tmp_machine"
chmod 600 "$tmp_machine"
mv "$tmp_machine" "$machine_config_path"
chmod 600 "$machine_config_path"

unset infisical_token infisical_client_secret

printf 'wrote %s\n' "$config_path"
printf 'wrote %s\n' "$machine_config_path"
printf 'verified machine identity access to %s\n' "$infisical_secret_path"
