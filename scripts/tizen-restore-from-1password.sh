#!/usr/bin/env bash
set -euo pipefail

account="${TIZEN_1PASSWORD_ACCOUNT:-}"
reference="${TIZEN_1PASSWORD_REFERENCE:-}"
output="${1:-$HOME/Downloads/tizen-certs.tar.gz}"
expected_sha="${TIZEN_CERTS_SHA256:-}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

require op
require shasum
require tar

if [ -z "$reference" ]; then
  printf 'TIZEN_1PASSWORD_REFERENCE is required, for example op://Vault/Item/archive\n' >&2
  exit 2
fi

if [ -z "$expected_sha" ]; then
  printf 'TIZEN_CERTS_SHA256 is required\n' >&2
  exit 2
fi

mkdir -p "$(dirname "$output")"

printf 'downloading Tizen cert archive from 1Password\n'
printf 'account: %s\n' "$account"
printf 'reference: %s\n' "$reference"
printf 'output: %s\n' "$output"

if [ -n "$account" ]; then
  op read --account "$account" --out-file "$output" "$reference"
else
  op read --out-file "$output" "$reference"
fi

actual_sha="$(shasum -a 256 "$output" | awk '{print $1}')"
if [ "$actual_sha" != "$expected_sha" ]; then
  printf 'checksum mismatch for %s\n' "$output" >&2
  printf 'expected: %s\n' "$expected_sha" >&2
  printf 'actual:   %s\n' "$actual_sha" >&2
  exit 1
fi

printf 'checksum ok: %s\n' "$actual_sha"
"$script_dir/tizen-restore.sh" "$output"
