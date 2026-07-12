#!/usr/bin/env bash

INFISICAL_SUDO_TMP_DIR=""

infisical_sudo_find_age() {
  local candidate
  for candidate in /opt/homebrew/bin/age /usr/local/bin/age /usr/bin/age; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  return 1
}

infisical_sudo_decrypt_age() {
  local age_bin="$1"
  local identity_file="$2"
  local ciphertext="$3"

  printf '%s\n' "$ciphertext" | "$age_bin" --decrypt -i "$identity_file"
}

infisical_sudo_cleanup() {
  if [ -n "$INFISICAL_SUDO_TMP_DIR" ]; then
    rm -rf "$INFISICAL_SUDO_TMP_DIR"
    INFISICAL_SUDO_TMP_DIR=""
  fi
}

infisical_sudo_install_cleanup_traps() {
  trap 'infisical_sudo_cleanup' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

infisical_sudo_exec() {
  local sudo_bin="$1"
  local askpass_bin="$2"
  local age_bin="$3"
  local identity_file="$4"
  local ciphertext="$5"
  shift 5
  local status=0
  local ciphertext_file
  local tmp_base

  tmp_base="${TMPDIR:-/tmp}"
  [ "$tmp_base" = "/" ] || tmp_base="${tmp_base%/}"
  [ -n "$tmp_base" ] && [ "${tmp_base#/}" != "$tmp_base" ] && [ -d "$tmp_base" ] || return 1
  INFISICAL_SUDO_TMP_DIR="$(mktemp -d "$tmp_base/uinaf-sudo.XXXXXX")" || return 1
  case "$INFISICAL_SUDO_TMP_DIR" in
    "$tmp_base"/uinaf-sudo.*) ;;
    *)
      infisical_sudo_cleanup
      return 1
      ;;
  esac
  chmod 700 "$INFISICAL_SUDO_TMP_DIR" || {
    infisical_sudo_cleanup
    return 1
  }
  ciphertext_file="$INFISICAL_SUDO_TMP_DIR/password.age"
  printf '%s\n' "$ciphertext" >"$ciphertext_file" || {
    infisical_sudo_cleanup
    return 1
  }
  chmod 600 "$ciphertext_file" || {
    infisical_sudo_cleanup
    return 1
  }
  unset ciphertext

  SUDO_ASKPASS="$askpass_bin" \
    INFISICAL_SUDO_AGE_BIN="$age_bin" \
    INFISICAL_SUDO_AGE_IDENTITY_FILE="$identity_file" \
    INFISICAL_SUDO_CIPHERTEXT_FILE="$ciphertext_file" \
    "$sudo_bin" -k -A -p '' -- "$@" || status=$?

  infisical_sudo_cleanup
  return "$status"
}
