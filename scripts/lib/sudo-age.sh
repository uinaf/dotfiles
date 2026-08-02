#!/usr/bin/env bash

SUDO_AGE_TMP_DIR=""

sudo_age_file_mode() {
  if [ "$(uname -s)" = Darwin ]; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

sudo_age_find_age() {
  local candidate
  for candidate in /opt/homebrew/bin/age /usr/local/bin/age /usr/bin/age; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  return 1
}

sudo_age_cleanup() {
  if [ -n "$SUDO_AGE_TMP_DIR" ]; then
    rm -rf "$SUDO_AGE_TMP_DIR"
    SUDO_AGE_TMP_DIR=""
  fi
}

sudo_age_install_cleanup_traps() {
  trap 'sudo_age_cleanup' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

sudo_age_prepare() {
  local ciphertext="$1"
  local ciphertext_file
  local tmp_base

  tmp_base="${TMPDIR:-/tmp}"
  [ "$tmp_base" = "/" ] || tmp_base="${tmp_base%/}"
  [ -n "$tmp_base" ] && [ "${tmp_base#/}" != "$tmp_base" ] && [ -d "$tmp_base" ] || return 1
  SUDO_AGE_TMP_DIR="$(mktemp -d "$tmp_base/dotfiles-sudo.XXXXXX")" || return 1
  case "$SUDO_AGE_TMP_DIR" in
    "$tmp_base"/dotfiles-sudo.*) ;;
    *)
      sudo_age_cleanup
      return 1
      ;;
  esac
  chmod 700 "$SUDO_AGE_TMP_DIR" || {
    sudo_age_cleanup
    return 1
  }
  ciphertext_file="$SUDO_AGE_TMP_DIR/password.age"
  printf '%s\n' "$ciphertext" >"$ciphertext_file" || {
    sudo_age_cleanup
    return 1
  }
  chmod 600 "$ciphertext_file" || {
    sudo_age_cleanup
    return 1
  }
  unset ciphertext
}

sudo_age_exec() {
  local sudo_bin="$1"
  local askpass_bin="$2"
  local age_bin="$3"
  local identity_file="$4"
  local ciphertext="$5"
  shift 5
  local status=0

  sudo_age_prepare "$ciphertext" || return 1

  SUDO_ASKPASS="$askpass_bin" \
    SUDO_AGE_BIN="$age_bin" \
    SUDO_AGE_IDENTITY_FILE="$identity_file" \
    SUDO_AGE_CIPHERTEXT_FILE="$SUDO_AGE_TMP_DIR/password.age" \
    "$sudo_bin" -k -A -p '' -- "$@" || status=$?

  sudo_age_cleanup
  return "$status"
}

sudo_age_exec_nested() {
  local sudo_bin="$1"
  local askpass_bin="$2"
  local age_bin="$3"
  local identity_file="$4"
  local ciphertext="$5"
  shift 5
  local status=0
  local nested_askpass

  sudo_age_prepare "$ciphertext" || return 1
  cp "$askpass_bin" "$SUDO_AGE_TMP_DIR/askpass" || {
    sudo_age_cleanup
    return 1
  }
  chmod 700 "$SUDO_AGE_TMP_DIR/askpass" || {
    sudo_age_cleanup
    return 1
  }
  ln -s "$age_bin" "$SUDO_AGE_TMP_DIR/age" || {
    sudo_age_cleanup
    return 1
  }
  ln -s "$identity_file" "$SUDO_AGE_TMP_DIR/identity" || {
    sudo_age_cleanup
    return 1
  }
  nested_askpass="$SUDO_AGE_TMP_DIR/askpass"

  SUDO_ASKPASS="$nested_askpass" \
    "$sudo_bin" -k -A -p '' -v || status=$?

  if [ "$status" -eq 0 ]; then
    SUDO_ASKPASS="$nested_askpass" "$@" || status=$?
  fi

  sudo_age_cleanup
  return "$status"
}
