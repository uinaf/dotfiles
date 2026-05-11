#!/usr/bin/env bash
set -euo pipefail

projects_root="${PROJECTS_ROOT:-$HOME/projects}"

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

pull_or_clone() {
  local repo="$1"
  local path="$2"
  local parent

  parent="$(dirname "$path")"
  mkdir -p "$parent"

  if [ -d "$path/.git" ]; then
    printf 'pulling %s\n' "$path"
    git -C "$path" pull --ff-only
    return
  fi

  if [ -e "$path" ]; then
    printf 'refusing to overwrite non-git path: %s\n' "$path" >&2
    exit 1
  fi

  printf 'cloning %s -> %s\n' "$repo" "$path"
  gh repo clone "$repo" "$path"
}

require git
require gh

gh auth status >/dev/null

repos=(
  "uinaf/dotfiles|$projects_root/uinaf/dotfiles"
  "uinaf/agents|$projects_root/uinaf/agents"
)

for entry in "${repos[@]}"; do
  IFS='|' read -r repo path <<< "$entry"
  pull_or_clone "$repo" "$path"
done

agents_sync="$projects_root/uinaf/agents/scripts/sync/sync.sh"

if [ -x "$agents_sync" ]; then
  printf 'syncing uinaf agents\n'
  "$agents_sync"
else
  printf 'missing or non-executable %s\n' "$agents_sync" >&2
  exit 1
fi

printf 'repos are ready under %s\n' "$projects_root"
