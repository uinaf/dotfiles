#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source_dir="$repo_root/chezmoi"
dry_run=0
verbose=0
profile=""
override_data=""
chezmoi_base=()

# shellcheck source=scripts/lib/profile.sh
. "$repo_root/scripts/lib/profile.sh"

usage() {
  cat <<'USAGE'
Usage:
  scripts/bootstrap/apply-dotfiles.sh [--profile PROFILE] [--dry-run] [--verbose]

Applies the repo-local chezmoi source state for personal-workstation, personal-devbox,
workstation, devbox, assistant, or service to $HOME. When --profile is omitted, the stored profile is used,
followed by DOTFILES_PROFILE for first-time setup.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      shift
      if [ "$#" -eq 0 ]; then
        usage >&2
        exit 2
      fi
      profile="$1"
      ;;
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
  local expected_type="$2"
  local backup
  local expected_link

  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    return
  fi

  if [ "$expected_type" = "symlink" ]; then
    if [ -L "$target" ]; then
      expected_link="$("${chezmoi_base[@]}" cat "$target")"
      if [ "$(readlink "$target")" = "$expected_link" ]; then
        return
      fi
    fi
  elif [ "$expected_type" = "file" ] && [ ! -L "$target" ] && "${chezmoi_base[@]}" cat "$target" | cmp -s - "$target"; then
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

  backup_path "$HOME/.agents/AGENTS.md" remove

  while IFS= read -r target; do
    [ -n "$target" ] || continue
    backup_path "$target" file
  done < <("${chezmoi_base[@]}" managed --include=files --path-style absolute)

  while IFS= read -r target; do
    [ -n "$target" ] || continue
    backup_path "$target" symlink
  done < <("${chezmoi_base[@]}" managed --include=symlinks --path-style absolute)
}

validate_local_agent_rules() {
  local path="$HOME/.config/dotfiles/agents.local.md"
  local mode
  local owner

  if [ -L "$path" ] && [ ! -e "$path" ]; then
    fail "local agent rules link is broken: $path"
  fi
  [ -e "$path" ] || return 0
  [ -f "$path" ] || fail "local agent rules must resolve to a regular file: $path"
  mode="$(stat -L -f '%Lp' "$path")" || fail "cannot inspect local agent rules mode: $path"
  owner="$(stat -L -f '%u' "$path")" || fail "cannot inspect local agent rules owner: $path"
  [ "$owner" = "$(id -u)" ] || fail "local agent rules must be owned by the current user: $path"
  [ $((8#$mode & 077)) -eq 0 ] || fail "local agent rules must not grant group or other access: $path"
}

[ -d "$source_dir" ] || fail "missing chezmoi source directory: $source_dir"
command -v chezmoi >/dev/null 2>&1 || fail "chezmoi is required; run scripts/bootstrap/brew-bundle.sh for the selected profile first"

if ! profile="$(dotfiles_resolve_profile "$profile")"; then
  printf 'a supported profile is required: personal-workstation, personal-devbox, workstation, devbox, assistant, or service\n' >&2
  exit 2
fi
override_data="$(printf '{"dotfilesProfile":"%s"}' "$profile")"
chezmoi_base=(
  chezmoi
  --source "$source_dir"
  --destination "$HOME"
  --override-data "$override_data"
)
config_dir="$HOME/.config/dotfiles"
[ ! -L "$config_dir" ] || fail "canonical config directory must not be a symlink: $config_dir"
[ ! -e "$config_dir" ] || [ -d "$config_dir" ] \
  || fail "canonical config path must be a directory: $config_dir"

if dotfiles_profile_is_developer "$profile"; then
  validate_local_agent_rules
fi
backup_preexisting_targets

cmd=("${chezmoi_base[@]}" --force apply)
if [ "$dry_run" -eq 1 ]; then
  cmd+=(--dry-run)
fi
if [ "$verbose" -eq 1 ]; then
  cmd+=(--verbose)
fi

"${cmd[@]}"
if [ "$dry_run" -eq 1 ]; then
  printf 'dotfiles previewed for %s with chezmoi source %s\n' "$profile" "$source_dir"
else
  printf 'dotfiles applied for %s with chezmoi source %s\n' "$profile" "$source_dir"
fi
