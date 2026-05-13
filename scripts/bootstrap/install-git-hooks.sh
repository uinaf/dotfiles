#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

git_common_dir="$(git -C "$repo_root" rev-parse --git-common-dir 2>/dev/null || true)"
if [ -z "$git_common_dir" ]; then
  printf 'not a Git checkout: %s\n' "$repo_root" >&2
  exit 1
fi

case "$git_common_dir" in
  /*) ;;
  *) git_common_dir="$repo_root/$git_common_dir" ;;
esac

hooks_dir="$git_common_dir/hooks"
pre_push="$hooks_dir/pre-push"

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
exec "$repo_root/scripts/verify/repo.sh" --skip-security
HOOK

chmod 0755 "$pre_push"
printf 'installed %s\n' "$pre_push"
