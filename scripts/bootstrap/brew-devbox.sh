#!/usr/bin/env bash
set -euo pipefail

if ! command -v brew >/dev/null 2>&1; then
  printf 'brew is required before running this script\n' >&2
  exit 1
fi

# Preserve the devbox prefix's existing shared-writer modes without weakening
# the caller's default shell umask. Policy still limits mutations to the owning
# admin identity.
umask 0002
exec brew "$@"
