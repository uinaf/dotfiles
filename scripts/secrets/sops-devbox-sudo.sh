#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck source=scripts/lib/config-paths.sh
. "$repo_root/scripts/lib/config-paths.sh"
# shellcheck source=scripts/lib/sudo-age.sh
. "$repo_root/scripts/lib/sudo-age.sh"

config_path="$(dotfiles_resolve_config_file "${DEVBOX_CONFIG:-}" devbox.env)"
sudo_age_identity_file="$(dotfiles_resolve_config_file "${SUDO_AGE_IDENTITY_FILE:-}" sudo-age-identity.txt)"

usage() {
  cat <<'USAGE'
Usage:
  scripts/secrets/sops-devbox-sudo.sh -- <command> [args...]
  scripts/secrets/sops-devbox-sudo.sh --nested -- <command> [args...]

Decrypts SUDO_PASSWORD_AGE from the configured SOPS payload, then exposes the
plaintext password only through a fixed sudo askpass process. Nested mode keeps
the child command unprivileged while allowing its narrow sudo calls.

Set SOPS_SUDO_SECRET_FILE in the owner-only devbox config. SOPS_AGE_KEY_FILE and
SUDO_AGE_IDENTITY_FILE may override their platform-default identity paths.
USAGE
}

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

sops_identity_path() {
  if [ -n "${SOPS_AGE_KEY_FILE:-}" ]; then
    printf '%s\n' "$SOPS_AGE_KEY_FILE"
  elif [ -n "${XDG_CONFIG_HOME:-}" ]; then
    printf '%s/sops/age/keys.txt\n' "$XDG_CONFIG_HOME"
  elif [ "$(uname -s)" = Darwin ]; then
    printf '%s/Library/Application Support/sops/age/keys.txt\n' "$HOME"
  else
    printf '%s/.config/sops/age/keys.txt\n' "$HOME"
  fi
}

find_sops() {
  local candidate
  for candidate in /opt/homebrew/bin/sops /usr/local/bin/sops /usr/bin/sops; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  return 1
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
  [ -n "${SUDO_PASSWORD_AGE:-}" ] || fail "SOPS returned an empty sudo credential"
  [ -x /usr/bin/sudo ] || fail "missing /usr/bin/sudo"
  [ -x "$repo_root/scripts/lib/sudo-age-askpass.sh" ] \
    || fail "missing sudo askpass helper"
  [ -f "$sudo_age_identity_file" ] || fail "missing $sudo_age_identity_file"
  local identity_mode
  identity_mode="$(sudo_age_file_mode "$sudo_age_identity_file")"
  [ "$identity_mode" = "600" ] \
    || fail "$sudo_age_identity_file mode is $identity_mode, expected 600"
  local age_bin
  age_bin="$(sudo_age_find_age)" || fail "missing age"
  local sudo_password_ciphertext="$SUDO_PASSWORD_AGE"
  unset SUDO_PASSWORD_AGE

  local command_status=0
  if [ "$execution_mode" = "nested" ]; then
    sudo_age_exec_nested \
      /usr/bin/sudo \
      "$repo_root/scripts/lib/sudo-age-askpass.sh" \
      "$age_bin" \
      "$sudo_age_identity_file" \
      "$sudo_password_ciphertext" \
      "$@" || command_status=$?
  else
    sudo_age_exec \
      /usr/bin/sudo \
      "$repo_root/scripts/lib/sudo-age-askpass.sh" \
      "$age_bin" \
      "$sudo_age_identity_file" \
      "$sudo_password_ciphertext" \
      "$@" || command_status=$?
  fi
  unset sudo_password_ciphertext
  return "$command_status"
}

if [ "${1:-}" = "--consume-secret" ]; then
  shift
  sudo_age_install_cleanup_traps
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

[ -f "$config_path" ] || fail "missing $config_path"
config_mode="$(sudo_age_file_mode "$config_path")"
[ "$config_mode" = "600" ] || fail "$config_path mode is $config_mode, expected 600"
# shellcheck disable=SC1090
. "$config_path"
[ -n "${SOPS_SUDO_SECRET_FILE:-}" ] \
  || fail "SOPS_SUDO_SECRET_FILE is required in $config_path"
[ -f "$SOPS_SUDO_SECRET_FILE" ] || fail "missing SOPS payload: $SOPS_SUDO_SECRET_FILE"
sudo_age_identity_file="$(dotfiles_resolve_config_file "${SUDO_AGE_IDENTITY_FILE:-}" sudo-age-identity.txt)"
sops_binary="${SOPS_BINARY:-$(find_sops)}" || fail "missing sops"
sops_age_identity_file="$(sops_identity_path)"
[ -f "$sops_age_identity_file" ] || fail "missing SOPS age identity: $sops_age_identity_file"

printf -v command '%q ' \
  "$repo_root/scripts/secrets/sops-devbox-sudo.sh" --consume-secret "$@"
export SUDO_AGE_IDENTITY_FILE="$sudo_age_identity_file"
SOPS_AGE_KEY_FILE="$sops_age_identity_file" \
  exec "$sops_binary" exec-env --same-process "$SOPS_SUDO_SECRET_FILE" "$command"
