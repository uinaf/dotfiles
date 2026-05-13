#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
hooks_dir="$repo_root/.git/hooks"
pre_push="$hooks_dir/pre-push"

if [ ! -d "$repo_root/.git" ]; then
  printf 'not a normal Git checkout: %s\n' "$repo_root" >&2
  exit 1
fi

mkdir -p "$hooks_dir"

if [ -e "$pre_push" ] || [ -L "$pre_push" ]; then
  if ! grep -q 'uinaf-dotfiles: pre-push' "$pre_push" 2>/dev/null; then
    backup="$pre_push.backup.$(date +%Y%m%d%H%M%S)"
    mv "$pre_push" "$backup"
    printf 'backed up existing pre-push hook to %s\n' "$backup"
  fi
fi

cat > "$pre_push" <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail

# uinaf-dotfiles: pre-push
repo_root="$(git rev-parse --show-toplevel)"
exec "$repo_root/scripts/bootstrap/verify-repo.sh" --skip-security
HOOK

chmod 0755 "$pre_push"
printf 'installed %s\n' "$pre_push"
