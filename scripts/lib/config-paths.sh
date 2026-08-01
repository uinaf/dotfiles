#!/usr/bin/env bash

dotfiles_resolve_config_path() {
  local explicit_path="${1:-}"
  local canonical_path="$2"
  local legacy_path="$3"

  if [ -n "$explicit_path" ]; then
    printf '%s\n' "$explicit_path"
  elif [ -e "$canonical_path" ] || [ -L "$canonical_path" ]; then
    printf '%s\n' "$canonical_path"
  elif [ -L "$(dirname "$legacy_path")" ]; then
    return 3
  elif [ -L "$legacy_path" ]; then
    return 3
  elif [ -e "$legacy_path" ]; then
    printf '%s\n' "$legacy_path"
  else
    printf '%s\n' "$canonical_path"
  fi
}

dotfiles_resolve_config_file() {
  local explicit_path="${1:-}"
  local name="$2"

  dotfiles_resolve_config_path \
    "$explicit_path" \
    "$HOME/.config/dotfiles/$name" \
    "$HOME/.config/uinaf/$name"
}
