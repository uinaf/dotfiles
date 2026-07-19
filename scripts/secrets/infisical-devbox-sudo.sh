#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
config_path="${DEVBOX_CONFIG:-$HOME/.config/uinaf/devbox.env}"
sudo_secret_name="${INFISICAL_SUDO_SECRET_NAME:-SUDO_PASSWORD_AGE}"
sudo_age_identity_file="${INFISICAL_SUDO_AGE_IDENTITY_FILE:-$HOME/.config/uinaf/sudo-age-identity.txt}"

# shellcheck source=scripts/lib/infisical.sh
. "$repo_root/scripts/lib/infisical.sh"
# shellcheck source=scripts/lib/infisical-sudo.sh
. "$repo_root/scripts/lib/infisical-sudo.sh"

usage() {
  cat <<'USAGE'
Usage:
  scripts/secrets/infisical-devbox-sudo.sh -- <command> [args...]
  scripts/secrets/infisical-devbox-sudo.sh --nested -- <command> [args...]

Fetches the current devbox user's encrypted sudo credential from Infisical.
The fixed askpass helper decrypts it only when sudo requests authentication;
the command retains its original stdin and never holds the credential.

Nested mode keeps the command unprivileged and provides the same askpass
boundary to sudo calls made by that command. Use it for tools such as Homebrew
that must start as the devbox user but may invoke sudo for a narrow operation.
USAGE
}

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

load_sudo_secret_path() {
  [ -e "$config_path" ] || fail "missing $config_path"
  local mode
  mode="$(infisical_file_mode "$config_path")"
  [ "$mode" = "600" ] || fail "$config_path mode is $mode, expected 600"
  # shellcheck disable=SC1090
  . "$config_path"
  [ -n "${INFISICAL_SUDO_SECRET_PATH:-}" ] \
    || fail "INFISICAL_SUDO_SECRET_PATH is required in $config_path"
}

consume_secret() {
  local execution_mode="direct"
  if [ "${1:-}" = "--nested" ]; then
    execution_mode="nested"
    shift
    if [ "${1:-}" = "--" ]; then
      shift
    fi
  fi
  [ "$#" -gt 0 ] || fail "missing sudo command"

  [ -n "${INFISICAL_TOKEN:-}" ] || fail "missing command-boundary Infisical token"
  [ -n "${INFISICAL_SECRET_PATH:-}" ] || fail "missing sudo secret path"
  command -v infisical >/dev/null || fail "missing infisical"
  [ -x /usr/bin/sudo ] || fail "missing /usr/bin/sudo"
  [ -x "$repo_root/scripts/lib/infisical-sudo-askpass.sh" ] \
    || fail "missing Infisical sudo askpass helper"
  [ -e "$sudo_age_identity_file" ] || fail "missing $sudo_age_identity_file"
  local identity_mode
  identity_mode="$(infisical_file_mode "$sudo_age_identity_file")"
  [ "$identity_mode" = "600" ] \
    || fail "$sudo_age_identity_file mode is $identity_mode, expected 600"
  local age_bin
  age_bin="$(infisical_sudo_find_age)" || fail "missing age"

  local sudo_password_ciphertext
  sudo_password_ciphertext="$(
    infisical secrets get "$sudo_secret_name" \
      --domain "$INFISICAL_DOMAIN" \
      --projectId "$INFISICAL_PROJECT_ID" \
      --env "$INFISICAL_ENV" \
      --path "$INFISICAL_SECRET_PATH" \
      --plain \
      --silent
  )" || fail "could not read encrypted sudo credential from Infisical"
  [ -n "$sudo_password_ciphertext" ] \
    || fail "Infisical returned an empty encrypted sudo credential"

  local status=0
  if [ "$execution_mode" = "nested" ]; then
    infisical_sudo_exec_nested \
      "$repo_root/scripts/lib/infisical-sudo-askpass.sh" \
      "$age_bin" \
      "$sudo_age_identity_file" \
      "$sudo_password_ciphertext" \
      "$@" || status=$?
  else
    infisical_sudo_exec \
      /usr/bin/sudo \
      "$repo_root/scripts/lib/infisical-sudo-askpass.sh" \
      "$age_bin" \
      "$sudo_age_identity_file" \
      "$sudo_password_ciphertext" \
      "$@" || status=$?
  fi
  unset sudo_password_ciphertext
  return "$status"
}

if [ "${1:-}" = "--consume-secret" ]; then
  shift
  [ "$#" -gt 0 ] || fail "missing sudo command"
  infisical_sudo_install_cleanup_traps
  consume_secret "$@"
  exit $?
fi

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

load_sudo_secret_path
INFISICAL_SECRET_PATH="$INFISICAL_SUDO_SECRET_PATH" \
  "$repo_root/scripts/secrets/infisical-devbox-run.sh" -- \
  "$repo_root/scripts/secrets/infisical-devbox-sudo.sh" --consume-secret "$@"
