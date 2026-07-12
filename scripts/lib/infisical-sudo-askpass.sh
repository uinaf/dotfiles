#!/usr/bin/env bash
set -euo pipefail

[ -n "${INFISICAL_SUDO_AGE_BIN:-}" ] || exit 1
[ -x "$INFISICAL_SUDO_AGE_BIN" ] || exit 1
[ -n "${INFISICAL_SUDO_AGE_IDENTITY_FILE:-}" ] || exit 1
[ -f "$INFISICAL_SUDO_AGE_IDENTITY_FILE" ] || exit 1
[ -n "${INFISICAL_SUDO_CIPHERTEXT_FILE:-}" ] || exit 1
[ -f "$INFISICAL_SUDO_CIPHERTEXT_FILE" ] || exit 1

exec "$INFISICAL_SUDO_AGE_BIN" \
  --decrypt \
  -i "$INFISICAL_SUDO_AGE_IDENTITY_FILE" \
  "$INFISICAL_SUDO_CIPHERTEXT_FILE"
