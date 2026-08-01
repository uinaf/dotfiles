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

dotfiles_resolve_profile() {
  local requested="${1:-${DOTFILES_PROFILE:-}}"
  local profile_file="${DOTFILES_PROFILE_FILE:-$HOME/.config/dotfiles/profile}"
  local legacy_profile_file="$HOME/.config/uinaf/profile"

  if [ -z "${DOTFILES_PROFILE_FILE:-}" ] \
    && [ ! -r "$profile_file" ] \
    && [ -r "$legacy_profile_file" ]; then
    profile_file="$legacy_profile_file"
  fi

  if [ -z "$requested" ] && [ -r "$profile_file" ]; then
    IFS= read -r requested < "$profile_file"
  fi

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
