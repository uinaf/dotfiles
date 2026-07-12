#!/usr/bin/env bash
set -euo pipefail

identity_file="${INFISICAL_SUDO_AGE_IDENTITY_FILE:-$HOME/.config/uinaf/sudo-age-identity.txt}"

usage() {
  cat <<'USAGE'
Usage:
  scripts/secrets/configure-infisical-devbox-sudo.sh

Creates the owner-only local age identity used to decrypt this devbox user's
Infisical sudo ciphertext. Prints only the public recipient. Back up the private
identity through the approved human recovery flow before storing ciphertext.
USAGE
}

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi
[ "$#" -eq 0 ] || {
  usage >&2
  exit 2
}

command -v age-keygen >/dev/null || fail "missing age-keygen"
mkdir -p "$(dirname "$identity_file")"
chmod 700 "$(dirname "$identity_file")"
if [ ! -e "$identity_file" ]; then
  umask 077
  age-keygen -o "$identity_file" >/dev/null 2>&1
fi
chmod 600 "$identity_file"

printf 'age identity ready: %s\n' "$identity_file"
printf 'public recipient: '
age-keygen -y "$identity_file"
