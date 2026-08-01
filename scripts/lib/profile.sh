#!/usr/bin/env bash

dotfiles_normalize_profile() {
  case "${1:-}" in
    personal)
      printf 'workstation\n'
      ;;
    workstation|devbox|assistant)
      printf '%s\n' "$1"
      ;;
    *)
      return 2
      ;;
  esac
}

dotfiles_trim_profile() {
  local value="${1:-}"

  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s\n' "$value"
}

dotfiles_read_persisted_profile() {
  local profile_file="$1"
  local expected_uid="${2:-}"
  local profile_mode=""
  local profile_uid=""
  local value=""

  [ -f "$profile_file" ] && [ ! -L "$profile_file" ] && [ -r "$profile_file" ] \
    || return 3
  if [ "$(uname -s)" = Darwin ]; then
    profile_mode="$(stat -f '%Lp' "$profile_file")" || return 3
    profile_uid="$(stat -f '%u' "$profile_file")" || return 3
  else
    profile_mode="$(stat -c '%a' "$profile_file" 2>/dev/null)" || return 3
    profile_uid="$(stat -c '%u' "$profile_file")" || return 3
  fi
  case "$profile_mode" in
    [0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]) ;;
    *) return 3 ;;
  esac
  case "$profile_mode" in
    *[2367][0-7]|*[0-7][2367]) return 3 ;;
  esac
  if [ -n "$expected_uid" ] && [ "$profile_uid" != "$expected_uid" ]; then
    return 3
  fi
  awk 'END { exit NR == 1 ? 0 : 1 }' "$profile_file" || return 3
  IFS= read -r value < "$profile_file" || return 3
  value="$(dotfiles_trim_profile "$value")"
  dotfiles_normalize_profile "$value" >/dev/null || return 3
  dotfiles_normalize_profile "$value"
}

dotfiles_resolve_profile() {
  local requested="${1:-}"
  local profile_file="${DOTFILES_PROFILE_FILE:-$HOME/.config/dotfiles/profile}"
  local legacy_profile_file="$HOME/.config/uinaf/profile"
  local explicit_profile_file=0

  if [ -n "${DOTFILES_PROFILE_FILE:-}" ]; then
    explicit_profile_file=1
  fi

  if [ "$explicit_profile_file" -eq 0 ] \
    && [ ! -e "$profile_file" ] \
    && [ ! -L "$profile_file" ] \
    && { [ -e "$legacy_profile_file" ] || [ -L "$legacy_profile_file" ]; }; then
    profile_file="$legacy_profile_file"
  fi

  if [ -z "$requested" ]; then
    if [ -e "$profile_file" ] || [ -L "$profile_file" ]; then
      requested="$(dotfiles_read_persisted_profile "$profile_file" "$(id -u)")" || return 3
    elif [ "$explicit_profile_file" -eq 1 ]; then
      return 3
    else
      requested="${DOTFILES_PROFILE:-}"
    fi
  fi

  requested="$(dotfiles_trim_profile "$requested")"
  [ -n "$requested" ] || return 1
  dotfiles_normalize_profile "$requested"
}

dotfiles_profile_is_developer() {
  case "$1" in
    workstation|devbox)
      return 0
      ;;
    assistant)
      return 1
      ;;
    *)
      return 2
      ;;
  esac
}

dotfiles_profile_uses_shared_brew() {
  case "$1" in
    devbox|assistant)
      return 0
      ;;
    workstation)
      return 1
      ;;
    *)
      return 2
      ;;
  esac
}

dotfiles_profile_brewfiles() {
  local profile="$1"

  printf 'Brewfile\n'
  if dotfiles_profile_is_developer "$profile"; then
    printf 'Brewfile.developer\n'
  fi
  printf 'Brewfile.%s\n' "$profile"
}
