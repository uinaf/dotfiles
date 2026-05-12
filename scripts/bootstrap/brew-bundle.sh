#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
profile=""

usage() {
  cat <<'USAGE'
Usage:
  scripts/bootstrap/brew-bundle.sh personal
  scripts/bootstrap/brew-bundle.sh devbox
  scripts/bootstrap/brew-bundle.sh --shared-only

Installs the shared Brewfile first, then the selected profile Brewfile.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    personal|devbox)
      if [ -n "$profile" ]; then
        usage >&2
        exit 2
      fi
      profile="$1"
      ;;
    --profile)
      shift
      if [ "$#" -eq 0 ]; then
        usage >&2
        exit 2
      fi
      case "$1" in
        personal|devbox)
          profile="$1"
          ;;
        *)
          usage >&2
          exit 2
          ;;
      esac
      ;;
    --shared-only)
      if [ -n "$profile" ]; then
        usage >&2
        exit 2
      fi
      profile="shared"
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

if [ -z "$profile" ]; then
  usage >&2
  exit 2
fi

if ! command -v brew >/dev/null 2>&1; then
  printf 'brew is required before running this script\n' >&2
  exit 1
fi

run_bundle() {
  local file="$1"
  printf '\n## brew bundle --file %s\n' "$file"
  brew bundle --file "$file"
}

run_bundle "$repo_root/Brewfile"

if [ "$profile" != "shared" ]; then
  run_bundle "$repo_root/Brewfile.$profile"
fi
