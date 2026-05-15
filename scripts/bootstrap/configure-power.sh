#!/usr/bin/env bash
set -euo pipefail

profile="personal"
check_only=0

usage() {
  cat <<'USAGE'
Usage:
  scripts/bootstrap/configure-power.sh [--profile personal|devbox] [--check]

Configures plugged-in macOS power policy for uinaf Macs:
  - disables system sleep on AC power
  - disables display sleep on AC power
  - disables disk sleep on AC power

Battery settings are intentionally left unchanged.
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
    personal|devbox)
      profile="$1"
      ;;
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

case "$profile" in
  personal|devbox)
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

if [ "$(uname -s)" != "Darwin" ]; then
  printf 'configure-power is macOS-only\n' >&2
  exit 1
fi

read_ac_setting() {
  local key="$1"
  pmset -g custom | awk -v key="$key" '
    /^AC Power:/ { in_ac = 1; next }
    /^[[:alpha:]].*:$/ && $0 !~ /^AC Power:/ { in_ac = 0 }
    in_ac && $1 == key { print $2; exit }
  '
}

check_ac_policy() {
  local failed=0
  local key
  local value

  for key in sleep displaysleep disksleep; do
    value="$(read_ac_setting "$key")"
    if [ "$value" = "0" ]; then
      printf 'ok AC %s=%s\n' "$key" "$value"
    else
      printf 'FAILED: AC %s=%s, expected 0\n' "$key" "${value:-missing}" >&2
      failed=1
    fi
  done

  return "$failed"
}

if [ "$check_only" -eq 1 ]; then
  check_ac_policy
  exit $?
fi

if [ "$(id -u)" -eq 0 ]; then
  pmset -c sleep 0 displaysleep 0 disksleep 0
else
  printf 'configure-power needs sudo to update system power settings\n' >&2
  sudo pmset -c sleep 0 displaysleep 0 disksleep 0
fi

check_ac_policy
printf 'plugged-in power policy configured (%s)\n' "$profile"
