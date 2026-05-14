#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
home_root="$repo_root/home"

backup_path() {
  local target="$1"
  if [ -e "$target" ] || [ -L "$target" ]; then
    local backup
    backup="$target.backup.$(date +%Y%m%d%H%M%S)"
    mv "$target" "$backup"
    printf 'backed up %s -> %s\n' "$target" "$backup"
  fi
}

link_file() {
  local source="$1"
  local target="$2"
  local current
  mkdir -p "$(dirname "$target")"
  if [ -L "$target" ] && [ "$(readlink "$target")" = "$source" ]; then
    printf 'already linked %s\n' "$target"
    return
  fi

  if [ -L "$target" ]; then
    current="$(readlink "$target")"
    if [[ "$current" = */dotfiles/home/* ]]; then
      unlink "$target"
      printf 'replaced old dotfiles link %s -> %s\n' "$target" "$current"
      ln -s "$source" "$target"
      printf 'linked %s -> %s\n' "$target" "$source"
      return
    fi
  fi

  backup_path "$target"
  ln -s "$source" "$target"
  printf 'linked %s -> %s\n' "$target" "$source"
}

copy_file() {
  local source="$1"
  local target="$2"
  local current
  mkdir -p "$(dirname "$target")"

  if [ -L "$target" ]; then
    current="$(readlink "$target")"
    if [[ "$current" = */dotfiles/home/* ]]; then
      unlink "$target"
      printf 'replaced dotfiles link with local file %s -> %s\n' "$target" "$current"
      install -m 0600 "$source" "$target"
      printf 'copied %s -> %s\n' "$source" "$target"
      return
    fi
  fi

  if [ -e "$target" ]; then
    if cmp -s "$source" "$target"; then
      printf 'already copied %s\n' "$target"
    else
      printf 'kept existing local file %s\n' "$target"
    fi
    return
  fi

  install -m 0600 "$source" "$target"
  printf 'copied %s -> %s\n' "$source" "$target"
}

should_copy_file() {
  case "$1" in
    .ssh/config|.config/zed/*|Library/Application\ Support/com.mitchellh.ghostty/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

remove_obsolete_link() {
  local target="$1"
  local old_source="$2"

  if [ -L "$target" ] && [ "$(readlink "$target")" = "$old_source" ]; then
    unlink "$target"
    printf 'removed obsolete link %s -> %s\n' "$target" "$old_source"
  fi
}

remove_obsolete_link_suffix() {
  local target="$1"
  local suffix="$2"
  local current

  if [ ! -L "$target" ]; then
    return
  fi

  current="$(readlink "$target")"
  if [[ "$current" = *"$suffix" ]]; then
    unlink "$target"
    printf 'removed obsolete link %s -> %s\n' "$target" "$current"
  fi
}

remove_obsolete_link "$HOME/.zlogin" "$home_root/.zlogin"
remove_obsolete_link "$HOME/.config/1Password/ssh/agent.toml" "$home_root/.config/1Password/ssh/agent.toml"
remove_obsolete_link_suffix "$HOME/.config/1Password/ssh/agent.toml" "/home/.config/1Password/ssh/agent.toml"
remove_obsolete_link_suffix "$HOME/.codex/config.toml" "/home/.codex/config.toml"
remove_obsolete_link_suffix "$HOME/.codex/browser/config.toml" "/home/.codex/browser/config.toml"

if git -C "$repo_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  file_list=(git -C "$repo_root" ls-files -z -- home)
else
  file_list=(find "$home_root" -type f -print0)
fi

"${file_list[@]}" | while IFS= read -r -d '' file; do
  if [[ "$file" = home/* ]]; then
    source="$repo_root/$file"
    rel="${file#home/}"
  else
    source="$file"
    rel="${source#"$home_root"/}"
  fi
  if should_copy_file "$rel"; then
    copy_file "$source" "$HOME/$rel"
  else
    link_file "$source" "$HOME/$rel"
  fi
done

if command -v codex >/dev/null 2>&1; then
  "$repo_root/scripts/bootstrap/configure-codex.sh"
else
  printf 'skipped Codex defaults; codex is not on PATH yet\n' >&2
fi
