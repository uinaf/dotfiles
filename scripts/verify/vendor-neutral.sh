#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
unexpected=0
matches=""
path_matches=""
grep_status=0

set +e
matches="$(git -C "$repo_root" grep --untracked -n -i uinaf -- ':!scripts/verify/vendor-neutral.sh')"
grep_status=$?
set -e
if [ "$grep_status" -ne 0 ] && [ "$grep_status" -ne 1 ]; then
  printf 'vendor-neutral scan failed with git grep status %s\n' "$grep_status" >&2
  exit "$grep_status"
fi

set +e
path_matches="$(git -C "$repo_root" ls-files --cached --others --exclude-standard | grep -i uinaf)"
grep_status=$?
set -e
if [ "$grep_status" -ne 0 ] && [ "$grep_status" -ne 1 ]; then
  printf 'vendor-neutral path scan failed with status %s\n' "$grep_status" >&2
  exit "$grep_status"
fi
while IFS= read -r branded_path; do
  [ -n "$branded_path" ] || continue
  printf 'unexpected vendor branding in path: %s\n' "$branded_path" >&2
  unexpected=1
done <<< "$path_matches"

while IFS=: read -r file line content; do
  [ -n "$file" ] || continue

  case "$file" in
    AGENTS.md)
      case "$content" in
        *"Do not add \`uinaf\` or another owner"*) continue ;;
      esac
      ;;
    Brewfile.developer|Brewfile.personal|Brewfile.devbox|CONTRIBUTING.md|LICENSE|README.md|SECURITY.md|docs/bootstrap.md|docs/profiles.md)
      case "$content" in
        *uinaf/dotfiles*|*uinaf/tap*|*github.com/uinaf/sops-vault-template*|*dev@uinaf.dev*|*'Copyright (c) 2026 uinaf'*) continue ;;
      esac
      ;;
    docs/identities.md)
      case "$content" in
        *github.com/uinaf/sops-vault-template*) continue ;;
      esac
      ;;
    docs/agents.md)
      case "$content" in
        *github.com/uinaf/skills*|*github.com/uinaf/attach*|*github.com/uinaf/autoreview*|*github.com/uinaf/slopshipper*|*github.com/uinaf/design*|*uinaf-design*) continue ;;
      esac
      ;;
    scripts/agents/skills/shared.json|scripts/agents/skills/personal.json)
      case "$content" in
        *'"name": "uinaf-design"'*|*'"name": "uinaf-radar"'*|*'"source": "uinaf/skills"'*|*'"source": "uinaf/attach"'*|*'"source": "uinaf/autoreview"'*|*'"source": "uinaf/slopshipper"'*|*'"source": "uinaf/design"'*|*'"source": "https://cdn.uinaf.dev/skills/ui"'*) continue ;;
      esac
      ;;
    scripts/agents/sync.test.ts)
      case "$content" in
        *uinaf/agents*|*uinaf/skills*|*uinaf/attach*|*uinaf/autoreview*|*uinaf/slopshipper*|*uinaf/design*|*uinaf-design*) continue ;;
      esac
      ;;
    scripts/verify/profiles.sh)
      case "$content" in
        *'uinaf/tap'*) continue ;;
      esac
      ;;
  esac

  printf 'unexpected vendor branding: %s:%s:%s\n' "$file" "$line" "$content" >&2
  unexpected=1
done <<< "$matches"

[ "$unexpected" -eq 0 ] || exit 1
printf 'ok owner names are limited to external coordinates\n'
