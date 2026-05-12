#!/usr/bin/env bash
set -euo pipefail

identity=""

usage() {
  cat <<'EOF'
usage: sudo scripts/devbox/install-op-token.sh --identity ID

Reads a 1Password service-account token from stdin and installs it into the
root-owned devbox token path:

  /var/db/uinaf/devbox-secrets/ID/op-sa-token

The token is not printed. It must be provided as a single line.
EOF
}

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --identity)
      identity="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[ "$(id -u)" -eq 0 ] || fail "must run as root"
[ -n "$identity" ] || fail "missing --identity"

case "$identity" in
  ''|*[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-]*)
    fail "identity may contain only letters, numbers, underscore, and dash"
    ;;
esac

IFS= read -r token || true
[ -n "${token:-}" ] || fail "empty token on stdin"

if IFS= read -r _extra; then
  fail "token input must be a single line"
fi

state_dir="/var/db/uinaf"
secret_base_dir="$state_dir/devbox-secrets"
secret_dir="$secret_base_dir/$identity"
token_file="$secret_dir/op-sa-token"

install -d -o root -g wheel -m 0711 "$state_dir"
install -d -o root -g wheel -m 0700 "$secret_base_dir" "$secret_dir"

tmp="$(mktemp "$secret_dir/op-sa-token.tmp.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
printf '%s\n' "$token" > "$tmp"
unset token
install -o root -g wheel -m 0400 "$tmp" "$token_file"
rm -f "$tmp"
trap - EXIT

printf 'installed token file: %s\n' "$token_file"
