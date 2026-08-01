#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
installer="$repo_root/scripts/bootstrap/install-devbox-service-daemons.sh"

# shellcheck source=scripts/lib/launchd.sh
. "$repo_root/scripts/lib/launchd.sh"

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

expected="$(printf '%s\n' \
  local.dotfiles.process-compose.example \
  local.dotfiles.openclaw-gateway.example \
  local.dotfiles.healthd.example \
  local.dotfiles.colima.example)"
actual="$(DOTFILES_LAUNCHD_NAMESPACE='' "$installer" --user example --print-labels)"
[ "$actual" = "$expected" ] || fail "default LaunchDaemon labels are not vendor-neutral"

custom="$("$installer" --user example --namespace org.example.dotfiles --print-labels)"
printf '%s\n' "$custom" | grep -Fqx 'org.example.dotfiles.healthd.example' \
  || fail "custom LaunchDaemon namespace was not applied"

custom_with_underscore="$("$installer" --user example --namespace org.example_team.dotfiles --print-labels)"
printf '%s\n' "$custom_with_underscore" | grep -Fqx 'org.example_team.dotfiles.healthd.example' \
  || fail "an advertised underscore in the LaunchDaemon namespace was rejected"

if "$installer" --user example --namespace 'invalid namespace' --print-labels >/dev/null 2>&1; then
  fail "invalid LaunchDaemon namespace was accepted"
fi

namespace_file="$(mktemp)"
trap 'rm -f "$namespace_file"' EXIT
printf 'org.example.dotfiles\n' > "$namespace_file"
[ "$(dotfiles_resolve_launchd_namespace_contract '' "$namespace_file")" = org.example.dotfiles ] \
  || fail "stored namespace was not reused"
[ "$(dotfiles_resolve_launchd_namespace_contract org.example.dotfiles "$namespace_file")" = org.example.dotfiles ] \
  || fail "matching explicit namespace was rejected"
if dotfiles_resolve_launchd_namespace_contract local.dotfiles "$namespace_file" >/dev/null 2>&1; then
  fail "conflicting explicit namespace was accepted"
fi
chmod 0644 "$namespace_file"
if dotfiles_resolve_launchd_namespace_contract '' "$namespace_file" >/dev/null 2>&1; then
  fail "group/world-readable stored namespace was accepted"
fi
chmod 0600 "$namespace_file"
printf 'org.example.dotfiles\nsecond.record\n' > "$namespace_file"
if dotfiles_resolve_launchd_namespace_contract '' "$namespace_file" >/dev/null 2>&1; then
  fail "multi-record stored namespace was accepted"
fi
: > "$namespace_file"
if dotfiles_resolve_launchd_namespace_contract '' "$namespace_file" >/dev/null 2>&1; then
  fail "empty stored namespace was accepted"
fi
rm "$namespace_file"
ln -s "$namespace_file.missing" "$namespace_file"
if dotfiles_resolve_launchd_namespace_contract local.dotfiles "$namespace_file" >/dev/null 2>&1; then
  fail "dangling stored namespace fell back to the requested namespace"
fi

if dotfiles_launchd_label healthd >/dev/null 2>&1; then
  fail "LaunchDaemon label accepted a missing user"
fi
if dotfiles_launchd_label '' example >/dev/null 2>&1; then
  fail "LaunchDaemon label accepted a missing service"
fi

printf 'ok LaunchDaemon labels are vendor-neutral and configurable\n'
