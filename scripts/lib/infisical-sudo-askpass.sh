#!/usr/bin/env bash
set -euo pipefail

if [ -n "${INFISICAL_SUDO_AGE_BIN:-}" ] \
  && [ -n "${INFISICAL_SUDO_AGE_IDENTITY_FILE:-}" ] \
  && [ -n "${INFISICAL_SUDO_CIPHERTEXT_FILE:-}" ]; then
  age_bin="$INFISICAL_SUDO_AGE_BIN"
  identity_file="$INFISICAL_SUDO_AGE_IDENTITY_FILE"
  ciphertext_file="$INFISICAL_SUDO_CIPHERTEXT_FILE"
else
  runtime_entrypoint="${SUDO_ASKPASS:-$0}"
  runtime_dir="${runtime_entrypoint%/*}"
  age_bin="$runtime_dir/age"
  identity_file="$runtime_dir/identity"
  ciphertext_file="$runtime_dir/password.age"
fi

[ -x "$age_bin" ] || exit 1
[ -f "$identity_file" ] || exit 1
[ -f "$ciphertext_file" ] || exit 1

exec "$age_bin" \
  --decrypt \
  -i "$identity_file" \
  "$ciphertext_file"
