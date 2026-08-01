#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
unexpected=0

while IFS=: read -r file line content; do
  [ -n "$file" ] || continue

  case "$file" in
    AGENTS.md)
      case "$content" in
        *"Do not add \`uinaf\` or another owner"*) continue ;;
      esac
      ;;
    Brewfile.devbox|CONTRIBUTING.md|LICENSE|README.md|SECURITY.md|docs/bootstrap.md)
      case "$content" in
        *uinaf/dotfiles*|*uinaf/tap*|*dev@uinaf.dev*|*'Copyright (c) 2026 uinaf'*) continue ;;
      esac
      ;;
    docs/devbox.md)
      case "$content" in
        *legacy*com.uinaf.*) continue ;;
      esac
      ;;
    scripts/bootstrap/install-devbox-service-daemons.sh)
      case "$content" in
        *retired_agent*com.uinaf.*|*check_job*com.uinaf.*|*retire_system_job*com.uinaf.*|*retire_agent*com.uinaf.*) continue ;;
      esac
      ;;
    scripts/verify/devbox-services.sh)
      case "$content" in
        *LaunchDaemons/com.uinaf.*) continue ;;
      esac
      ;;
    docs/profiles.md|scripts/bootstrap/apply-dotfiles.sh|scripts/lib/profile.sh|scripts/verify/profiles.sh)
      case "$content" in
        *config/uinaf*) continue ;;
      esac
      ;;
    scripts/bootstrap/configure-git.sh|scripts/bootstrap/install-git-hooks.sh|scripts/verify/configure-git.sh)
      case "$content" in
        *uinaf*dotfiles*) continue ;;
      esac
      ;;
    scripts/verify/assistant-git-boundary.sh)
      case "$content" in
        *libexec/uinaf*) continue ;;
      esac
      ;;
  esac

  printf 'unexpected vendor branding: %s:%s:%s\n' "$file" "$line" "$content" >&2
  unexpected=1
done < <(git -C "$repo_root" grep -n -i uinaf -- ':!scripts/verify/vendor-neutral.sh' || true)

[ "$unexpected" -eq 0 ] || exit 1
printf 'ok owner names are limited to external coordinates and legacy compatibility\n'
