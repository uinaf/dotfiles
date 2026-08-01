#!/usr/bin/env bash

dotfiles_resolve_config_path() {
  local explicit_path="${1:-}"
  local canonical_path="$2"

  if [ -n "$explicit_path" ]; then
    printf '%s\n' "$explicit_path"
  else
    printf '%s\n' "$canonical_path"
  fi
}

dotfiles_resolve_config_file() {
  local explicit_path="${1:-}"
  local name="$2"

  dotfiles_resolve_config_path \
    "$explicit_path" \
    "$HOME/.config/dotfiles/$name"
}
