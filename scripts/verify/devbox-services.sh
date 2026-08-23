#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck source=scripts/lib/config-paths.sh
. "$repo_root/scripts/lib/config-paths.sh"
# shellcheck source=scripts/lib/launchd.sh
. "$repo_root/scripts/lib/launchd.sh"

config_path="$(dotfiles_resolve_config_file "${DEVBOX_CONFIG:-}" devbox.env)"
devbox_user="${DEVBOX_USER:-$USER}"

usage() {
  cat <<'USAGE'
Usage:
  scripts/verify/devbox-services.sh

Checks the local devbox config, SOPS age identity, and managed system
LaunchDaemons for the current Unix user.
USAGE
}

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

mode_of() {
  if [ "$(uname -s)" = Darwin ]; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

check_config() {
  printf '\n## local devbox config\n'
  if [ -e "$config_path" ]; then
    [ "$(mode_of "$config_path")" = 600 ] \
      || fail "$config_path must have mode 0600"
    # shellcheck disable=SC1090
    . "$config_path"
    devbox_user="${DEVBOX_USER:-$devbox_user}"
    printf 'ok %s mode 600\n' "$config_path"
  else
    printf 'ok optional %s is absent; using defaults\n' "$config_path"
  fi
}

check_sops_identity() {
  printf '\n## SOPS age identity\n'
  "$repo_root/scripts/secrets/configure-sops-age-identity.sh" --check >/dev/null
  printf 'ok owner, permissions, recipient, and SOPS round trip\n'
}

check_launchd_daemons() {
  printf '\n## managed launchd daemons\n'
  local plist label namespace namespace_file namespace_status found=0 service
  case "$devbox_user" in
    ""|*[!A-Za-z0-9._-]*) fail "unsupported DEVBOX_USER: $devbox_user" ;;
  esac
  namespace_file="$HOME/.config/dotfiles/launchd-namespace"
  if namespace="$(dotfiles_resolve_launchd_namespace_contract "${DOTFILES_LAUNCHD_NAMESPACE:-}" "$namespace_file" "$(id -u)")"; then
    :
  else
    namespace_status=$?
    if [ "$namespace_status" -eq 3 ]; then
      fail "DOTFILES_LAUNCHD_NAMESPACE differs from the stored host contract"
    fi
    fail "invalid DOTFILES_LAUNCHD_NAMESPACE or stored namespace"
  fi

  for service in colima t3-code; do
    plist="/Library/LaunchDaemons/$namespace.$service.$devbox_user.plist"
    if [ -e "$plist" ]; then
      found=1
      label="$(basename "$plist" .plist)"
      [ "$(stat -f '%Su:%Sg:%Lp' "$plist")" = "root:wheel:644" ] \
        || fail "$label plist must be root:wheel mode 0644"
      launchctl print "system/$label" >/dev/null 2>&1 || fail "$label is not loaded"
      printf 'ok %s loaded\n' "$label"
    fi
  done

  [ "$found" -eq 1 ] || printf 'ok no managed developer system daemons on this machine\n'
}

case "${1:-}" in
  "") ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

check_config
check_sops_identity
check_launchd_daemons

printf '\ndevbox verification ok\n'
