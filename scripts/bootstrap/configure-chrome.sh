#!/usr/bin/env bash
set -euo pipefail

state_path="${CHROME_LOCAL_STATE:-$HOME/Library/Application Support/Google/Chrome/Local State}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
flag_name="vertical-tabs"
flag_value="vertical-tabs@1"
mode="enable"
allow_running=0

usage() {
  cat <<'USAGE'
Usage:
  scripts/bootstrap/configure-chrome.sh [options]

Enables Chrome's native vertical tabs flag in the local Chrome "Local State"
file. Quit Chrome before running this script so Chrome does not overwrite the
change on exit.

Options:
  --state PATH       Chrome Local State path
  --disable          remove the vertical-tabs flag
  --allow-running    write even when Chrome appears to be running
  -h, --help

After enabling, relaunch Chrome and move tabs to the side from Chrome's tab bar
context menu or Settings > Appearance when the option is available.
USAGE
}

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

chrome_is_running() {
  pgrep -x "Google Chrome" >/dev/null 2>&1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --state)
      shift
      [ "$#" -gt 0 ] || fail "--state requires a value"
      state_path="$1"
      ;;
    --disable)
      mode="disable"
      ;;
    --allow-running)
      allow_running=1
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

if [ "$allow_running" -eq 0 ] && chrome_is_running; then
  fail "quit Google Chrome before changing Local State, or rerun with --allow-running"
fi

node "$repo_root/scripts/bootstrap/chrome-state.ts" "$state_path" "$mode" "$flag_name" "$flag_value"

if [ "$mode" = "enable" ]; then
  printf 'enabled Chrome flag: %s in %s\n' "$flag_value" "$state_path"
else
  printf 'disabled Chrome flag: %s in %s\n' "$flag_name" "$state_path"
fi
