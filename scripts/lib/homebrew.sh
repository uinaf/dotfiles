#!/usr/bin/env bash

dotfiles_homebrew_path_uid() {
  local target="$1"

  if stat -f '%u' "$target" >/dev/null 2>&1; then
    stat -f '%u' "$target"
  else
    stat -c '%u' "$target"
  fi
}

dotfiles_homebrew_require_prefix_owner() {
  local prefix
  local owner_uid
  local current_uid
  local owner_name
  local current_name

  prefix="$(brew --prefix)" || return 1
  [ -d "$prefix" ] || {
    printf 'Homebrew prefix does not exist: %s\n' "$prefix" >&2
    return 1
  }

  owner_uid="$(dotfiles_homebrew_path_uid "$prefix")" || return 1
  current_uid="$(id -u)"
  if [ "$current_uid" = "$owner_uid" ]; then
    return 0
  fi

  owner_name="$(id -un "$owner_uid" 2>/dev/null || printf 'uid %s' "$owner_uid")"
  current_name="$(id -un)"
  printf 'Homebrew mutations must run as prefix owner %s; current user is %s\n' \
    "$owner_name" "$current_name" >&2
  return 1
}

dotfiles_homebrew_bundle_check() {
  HOMEBREW_NO_AUTO_UPDATE=1 brew bundle check --file "$1"
}
