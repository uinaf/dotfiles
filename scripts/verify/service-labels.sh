#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
installer="$repo_root/scripts/bootstrap/install-devbox-service-daemons.sh"

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

expected="$(printf '%s\n' \
  local.dotfiles.process-compose.example \
  local.dotfiles.openclaw-gateway.example \
  local.dotfiles.healthd.example \
  local.dotfiles.colima.example)"
actual="$("$installer" --user example --print-labels)"
[ "$actual" = "$expected" ] || fail "default LaunchDaemon labels are not vendor-neutral"

custom="$("$installer" --user example --namespace org.example.dotfiles --print-labels)"
printf '%s\n' "$custom" | grep -Fqx 'org.example.dotfiles.healthd.example' \
  || fail "custom LaunchDaemon namespace was not applied"

if "$installer" --user example --namespace 'invalid namespace' --print-labels >/dev/null 2>&1; then
  fail "invalid LaunchDaemon namespace was accepted"
fi

printf 'ok LaunchDaemon labels are vendor-neutral and configurable\n'
