#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
config_path="${DEVBOX_CONFIG:-$HOME/.config/uinaf/devbox.env}"
machine_config_path="${INFISICAL_MACHINE_CONFIG:-$HOME/.config/uinaf/infisical-machine.env}"
machine_auth_required="${INFISICAL_MACHINE_AUTH_REQUIRED:-1}"
devbox_user="${DEVBOX_USER:-$USER}"
process_compose_enabled="${PROCESS_COMPOSE_ENABLED:-1}"
process_compose_port="${PROCESS_COMPOSE_PORT:-9191}"
process_compose_socket="${PROCESS_COMPOSE_SOCKET:-}"
infisical_domain="${INFISICAL_DOMAIN:-https://eu.infisical.com/api}"
infisical_project_id="${INFISICAL_PROJECT_ID:-}"
infisical_env="${INFISICAL_ENV:-dev}"
infisical_secret_path="${INFISICAL_SECRET_PATH:-}"
infisical_sudo_secret_path="${INFISICAL_SUDO_SECRET_PATH:-}"
infisical_sudo_age_identity_file="${INFISICAL_SUDO_AGE_IDENTITY_FILE:-$HOME/.config/uinaf/sudo-age-identity.txt}"

# shellcheck source=scripts/lib/infisical.sh
. "$repo_root/scripts/lib/infisical.sh"
# shellcheck source=scripts/lib/infisical-sudo.sh
. "$repo_root/scripts/lib/infisical-sudo.sh"

usage() {
  cat <<'USAGE'
Usage:
  scripts/verify/devbox-services.sh

Checks devbox supervisor, uinaf healthd/colima system LaunchDaemons, Infisical
CLI availability, persistent machine auth, and default-shell token boundaries
for the current Unix user. Configure process-compose and Infisical selectors
through ~/.config/uinaf/devbox.env.
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
  infisical_file_mode "$1"
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
    devbox_user="${DEVBOX_USER:-$devbox_user}"
    process_compose_enabled="${PROCESS_COMPOSE_ENABLED:-$process_compose_enabled}"
    process_compose_port="${PROCESS_COMPOSE_PORT:-$process_compose_port}"
    process_compose_socket="${PROCESS_COMPOSE_SOCKET:-$process_compose_socket}"
    infisical_domain="${INFISICAL_DOMAIN:-$infisical_domain}"
    infisical_project_id="${INFISICAL_PROJECT_ID:-$infisical_project_id}"
    infisical_env="${INFISICAL_ENV:-$infisical_env}"
    infisical_sudo_secret_path="${INFISICAL_SUDO_SECRET_PATH:-$infisical_sudo_secret_path}"
  else
    if [ "$machine_auth_required" = "1" ]; then
      fail "missing $config_path"
    fi
    printf 'warn missing optional %s; using defaults\n' "$config_path"
  fi
}

check_no_default_secret_exports() {
  section "default shell secret boundary"

  if zsh -lic 'test -z "${INFISICAL_TOKEN+x}" && test -z "${INFISICAL_CLIENT_ID+x}" && test -z "${INFISICAL_CLIENT_SECRET+x}"'; then
    printf 'ok Infisical auth material is not exported by default login shell\n'
  else
    fail "Infisical auth material is exported by the default login shell"
  fi
}

load_machine_config() {
  if [ -e "$machine_config_path" ]; then
    check_mode "$machine_config_path" 600
    unset INFISICAL_CLIENT_ID INFISICAL_CLIENT_SECRET
    # shellcheck disable=SC1090
    . "$machine_config_path"
    printf 'ok loaded Infisical machine config\n'
    return
  fi

  if [ "$machine_auth_required" = "1" ]; then
    fail "missing $machine_config_path"
  fi

  printf 'warn missing optional %s; skipped persistent machine identity proof\n' "$machine_config_path"
}

check_infisical() {
  section "infisical"
  local status_json
  local status_exit=0
  local access_token

  command -v infisical >/dev/null || fail "missing infisical"
  infisical --version >/dev/null || fail "infisical CLI does not run"
  printf 'ok infisical installed\n'

  infisical_capture_login_status "$infisical_domain"
  status_json="$INFISICAL_LOGIN_STATUS_JSON"
  status_exit="$INFISICAL_LOGIN_STATUS_EXIT"
  if [ -z "$status_json" ] || ! infisical_status_has_sessions; then
    fail "could not inspect Infisical login status"
  fi
  if infisical_status_has_authenticated_human_user; then
    fail "Infisical CLI has an authenticated human user session"
  fi
  if [ "$status_exit" -eq 0 ]; then
    printf 'ok no authenticated Infisical human user session\n'
  elif infisical_status_has_only_inactive_sessions; then
    printf 'ok no authenticated Infisical human user session; CLI returned nonzero for inactive session state\n'
  else
    fail "could not verify Infisical login status session state"
  fi

  load_machine_config

  if [ -z "${INFISICAL_CLIENT_ID:-}" ] || [ -z "${INFISICAL_CLIENT_SECRET:-}" ]; then
    if [ "$machine_auth_required" = "1" ]; then
      fail "Infisical machine config is missing client credentials"
    fi
    printf 'warn skipped Infisical machine identity path proof; missing client credentials\n'
    return
  fi

  if [ -z "$infisical_project_id" ]; then
    if [ "$machine_auth_required" = "1" ]; then
      fail "missing INFISICAL_PROJECT_ID"
    fi
    printf 'warn skipped Infisical machine identity token proof; set INFISICAL_PROJECT_ID in %s\n' "$config_path"
    return
  fi

  access_token="$(infisical_mint_machine_token "$infisical_domain" "$INFISICAL_CLIENT_ID" "$INFISICAL_CLIENT_SECRET")" \
    || fail "could not mint Infisical machine identity token"

  printf 'ok Infisical machine identity can mint token for project %s\n' "$infisical_project_id"

  if [ -z "$infisical_secret_path" ]; then
    printf 'warn skipped Infisical path proof; set INFISICAL_SECRET_PATH for a command-boundary path check\n'
  else
    INFISICAL_TOKEN="$access_token" infisical export \
      --domain "$infisical_domain" \
      --projectId "$infisical_project_id" \
      --env "$infisical_env" \
      --path "$infisical_secret_path" \
      --format json \
      --silent >/dev/null \
      || fail "Infisical machine identity cannot read $infisical_secret_path"
    printf 'ok Infisical machine identity can read %s\n' "$infisical_secret_path"
  fi

  if [ -n "$infisical_sudo_secret_path" ]; then
    local sudo_ciphertext
    sudo_ciphertext="$(
      INFISICAL_TOKEN="$access_token" infisical secrets get SUDO_PASSWORD_AGE \
        --domain "$infisical_domain" \
        --projectId "$infisical_project_id" \
        --env "$infisical_env" \
        --path "$infisical_sudo_secret_path" \
        --plain \
        --silent
    )" || fail "Infisical machine identity cannot read its sudo credential"
    [ -n "$sudo_ciphertext" ] || fail "encrypted sudo credential is missing or empty"
    printf 'ok Infisical machine identity can read its encrypted sudo credential\n'
    check_mode "$infisical_sudo_age_identity_file" 600
    local sudo_age_bin
    sudo_age_bin="$(infisical_sudo_find_age 2>/dev/null || true)"
    [ -n "$sudo_age_bin" ] || fail "missing age"
    infisical_sudo_decrypt_age \
      "$sudo_age_bin" \
      "$infisical_sudo_age_identity_file" \
      "$sudo_ciphertext" >/dev/null \
      || fail "local age identity cannot decrypt the sudo credential"
    unset sudo_ciphertext
    printf 'ok local age identity decrypts the configured sudo credential\n'
  fi
}

check_launchd_daemons() {
  section "uinaf launchd daemons"

  local plist label found=0

  for plist in /Library/LaunchDaemons/com.uinaf.healthd.*.plist /Library/LaunchDaemons/com.uinaf.colima.*.plist; do
    [ -e "$plist" ] || continue
    found=1
    label="$(basename "$plist" .plist)"
    [ "$(stat -f '%Su:%Sg:%Lp' "$plist")" = "root:wheel:644" ] \
      || fail "$label plist must be root:wheel mode 0644"
    launchctl print "system/$label" >/dev/null 2>&1 || fail "$label is not loaded"
    printf 'ok %s loaded\n' "$label"
  done

  [ "$found" -eq 1 ] || printf 'ok no uinaf healthd/colima system daemons on this machine\n'
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
check_launchd_daemons
check_process_compose

printf '\ndevbox verification ok\n'
