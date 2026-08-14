#!/usr/bin/env bash
set -euo pipefail

uninstall_app_ids=(
  682658836 # GarageBand
  408981434 # iMovie
)

usage() {
  cat <<'USAGE'
Usage:
  scripts/app-store/personal.sh [--dry-run] [-h|--help]

Removes bundled Mac App Store apps unused by the personal workstation profile.

This script intentionally lives outside Brewfile because Mac App Store removal
depends on the interactive user's App Store session and may require a local
administrator password.
USAGE
}

dry_run=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
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
done

if ! command -v mas >/dev/null 2>&1; then
  printf 'mas is required; install the personal Brewfile first\n' >&2
  exit 1
fi

installed_ids() {
  mas list | awk '{ print $1 }'
}

is_installed() {
  local app_id="$1"

  installed_ids | grep -qx "$app_id"
}

run_root_mas() {
  if [ "$dry_run" -eq 1 ]; then
    printf 'dry-run sudo mas %s\n' "$*"
  else
    sudo mas "$@"
  fi
}

for app_id in "${uninstall_app_ids[@]}"; do
  if is_installed "$app_id"; then
    printf 'uninstalling App Store app: %s\n' "$app_id"
    run_root_mas uninstall "$app_id"
  else
    printf 'ok App Store app already absent: %s\n' "$app_id"
  fi
done
