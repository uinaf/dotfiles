#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOTFILES_AUDIT_NAME=personal-security \
  exec "$repo_root/scripts/audit/workstation.sh" "$@"
