#!/usr/bin/env bash
set -euo pipefail

check_only=0

usage() {
  cat <<'USAGE'
Usage:
  scripts/bootstrap/configure-spotlight.sh [--check]

Disables Spotlight indexing on all mounted macOS volumes.

This is a deliberate sudo step because mdutil changes system indexing policy.
It does not delete existing Spotlight index data.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check)
      check_only=1
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

if [ "$(uname -s)" != "Darwin" ]; then
  printf 'configure-spotlight is macOS-only\n' >&2
  exit 1
fi

check_spotlight_policy() {
  local output

  output="$(mdutil -sa 2>&1)"
  printf '%s\n' "$output"

  if grep -q 'Indexing enabled' <<< "$output"; then
    printf 'FAILED: Spotlight indexing is enabled on at least one volume\n' >&2
    return 1
  fi

  printf 'ok Spotlight indexing disabled\n'
}

if [ "$check_only" -eq 1 ]; then
  check_spotlight_policy
  exit $?
fi

if [ "$(id -u)" -eq 0 ]; then
  mdutil -a -i off
else
  printf 'configure-spotlight needs sudo to update Spotlight indexing policy\n' >&2
  sudo mdutil -a -i off
fi

check_spotlight_policy
printf 'Spotlight indexing disabled\n'
