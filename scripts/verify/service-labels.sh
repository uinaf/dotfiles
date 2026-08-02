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

custom_expected="$(printf '%s\n' \
  org.example.dotfiles.process-compose.example \
  org.example.dotfiles.openclaw-gateway.example \
  org.example.dotfiles.healthd.example \
  org.example.dotfiles.colima.example)"
custom="$("$installer" --user example --namespace org.example.dotfiles --print-labels)"
[ "$custom" = "$custom_expected" ] || fail "custom LaunchDaemon namespace was not applied consistently"

underscore_expected="$(printf '%s\n' \
  org.example_team.dotfiles.process-compose.example \
  org.example_team.dotfiles.openclaw-gateway.example \
  org.example_team.dotfiles.healthd.example \
  org.example_team.dotfiles.colima.example)"
custom_with_underscore="$("$installer" --user example --namespace org.example_team.dotfiles --print-labels)"
[ "$custom_with_underscore" = "$underscore_expected" ] \
  || fail "an advertised underscore was not applied consistently"

restart_rule="$(dotfiles_openclaw_restart_sudoers_rule \
  example \
  local.dotfiles.openclaw-gateway.example)"
[ "$restart_rule" = \
  'example ALL=(root) NOPASSWD: /bin/launchctl kickstart -k system/local.dotfiles.openclaw-gateway.example' ] \
  || fail "OpenClaw restart sudoers rule is not exact"
if dotfiles_openclaw_restart_sudoers_rule 'bad user' local.dotfiles.openclaw-gateway.example >/dev/null 2>&1; then
  fail "OpenClaw restart sudoers rule accepted an invalid user"
fi
if dotfiles_openclaw_restart_sudoers_rule example 'local.dotfiles.openclaw-gateway.example *' >/dev/null 2>&1; then
  fail "OpenClaw restart sudoers rule accepted an invalid label"
fi
dot_name="$(dotfiles_openclaw_restart_sudoers_name a.b 501)"
underscore_name="$(dotfiles_openclaw_restart_sudoers_name a_b 502)"
[ "$dot_name" = dotfiles-openclaw-restart-a_b-501 ] \
  || fail "OpenClaw restart sudoers filename missed the readable user and UID"
[ "$dot_name" != "$underscore_name" ] \
  || fail "OpenClaw restart sudoers filenames can collide across distinct users"
if dotfiles_openclaw_restart_sudoers_name example 'not-a-uid' >/dev/null 2>&1; then
  fail "OpenClaw restart sudoers filename accepted an invalid UID"
fi

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

if "$installer" --user example --process-compose --openclaw-port 18790 >/dev/null 2>&1; then
  fail "OpenClaw port was accepted without --openclaw"
fi
if "$installer" --user example --process-compose --openclaw-wrapper /tmp/wrapper >/dev/null 2>&1; then
  fail "OpenClaw wrapper was accepted without --openclaw"
fi
if "$installer" --user example --openclaw --openclaw-port 99999999999999999999 >/dev/null 2>&1; then
  fail "oversized OpenClaw port was accepted"
fi

printf 'ok LaunchDaemon labels are vendor-neutral and configurable\n'
