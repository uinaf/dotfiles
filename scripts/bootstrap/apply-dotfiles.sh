#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source_dir="$repo_root/chezmoi"
dry_run=0
verbose=0

usage() {
  cat <<'USAGE'
Usage:
  scripts/bootstrap/apply-dotfiles.sh [--dry-run] [--verbose]

Applies the repo-local chezmoi source state to $HOME.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      dry_run=1
      ;;
    --verbose)
      verbose=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  shift
done

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

backup_path() {
  local target="$1"
  local backup

  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    return
  fi

  if chezmoi --source "$source_dir" --destination "$HOME" cat "$target" | cmp -s - "$target"; then
    return
  fi

  backup="$target.backup.$(date +%Y%m%d%H%M%S)"
  if [ "$dry_run" -eq 1 ]; then
    printf 'would back up %s -> %s\n' "$target" "$backup"
  else
    mv "$target" "$backup"
    printf 'backed up %s -> %s\n' "$target" "$backup"
  fi
}

backup_preexisting_targets() {
  local target
  local current

  while IFS= read -r target; do
    [ -n "$target" ] || continue

    if [ -L "$target" ]; then
      current="$(readlink "$target")"
      if [[ "$current" = */dotfiles/home/* ]]; then
        continue
      fi
    fi

    backup_path "$target"
  done < <(chezmoi --source "$source_dir" --destination "$HOME" managed --include=files,symlinks --path-style absolute)
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
    if [ "$dry_run" -eq 1 ]; then
      printf 'would remove obsolete link %s -> %s\n' "$target" "$current"
    else
      unlink "$target"
      printf 'removed obsolete link %s -> %s\n' "$target" "$current"
    fi
  fi
}

[ -d "$source_dir" ] || fail "missing chezmoi source directory: $source_dir"
command -v chezmoi >/dev/null 2>&1 || fail "chezmoi is required; run scripts/bootstrap/brew-bundle.sh for the selected profile first"

remove_obsolete_link_suffix "$HOME/.zlogin" "/home/.zlogin"
remove_obsolete_link_suffix "$HOME/.config/1Password/ssh/agent.toml" "/home/.config/1Password/ssh/agent.toml"
remove_obsolete_link_suffix "$HOME/.codex/config.toml" "/home/.codex/config.toml"
remove_obsolete_link_suffix "$HOME/.codex/browser/config.toml" "/home/.codex/browser/config.toml"
backup_preexisting_targets

cmd=(chezmoi --source "$source_dir" --destination "$HOME" --force apply)
if [ "$dry_run" -eq 1 ]; then
  cmd+=(--dry-run)
fi
if [ "$verbose" -eq 1 ]; then
  cmd+=(--verbose)
fi

"${cmd[@]}"
if [ "$dry_run" -eq 1 ]; then
  printf 'dotfiles previewed with chezmoi source %s\n' "$source_dir"
else
  printf 'dotfiles applied with chezmoi source %s\n' "$source_dir"
fi
