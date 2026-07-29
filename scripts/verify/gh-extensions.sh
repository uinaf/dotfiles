#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
installer="$repo_root/scripts/bootstrap/install-gh-extensions.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
mkdir -p "$tmp_dir/bin"

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

cat >"$tmp_dir/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf 'arg=%s\n' "$@" >>"$FAKE_GH_LOG"

case "${1:-} ${2:-}" in
  "extension install"|"stack --help")
    ;;
  *)
    exit 64
    ;;
esac
EOF
chmod 755 "$tmp_dir/bin/gh"

log="$tmp_dir/gh.log"
: >"$log"
PATH="$tmp_dir/bin:/usr/bin:/bin" FAKE_GH_LOG="$log" "$installer" >/dev/null

expected="$(
  printf '%s\n' \
    'arg=extension' \
    'arg=install' \
    'arg=github/gh-stack' \
    'arg=--force' \
    'arg=stack' \
    'arg=--help'
)"
actual="$(cat "$log")"
[ "$actual" = "$expected" ] || fail "installer did not install and verify github/gh-stack"

set +e
output="$(PATH="$tmp_dir/empty" /bin/bash "$installer" 2>&1)"
status=$?
set -e
[ "$status" -eq 1 ] || fail "missing gh returned $status instead of 1"
printf '%s\n' "$output" | grep -Fq 'gh is required; install the shared Brewfile first' \
  || fail "missing gh failure was not actionable"

printf 'ok GitHub CLI extension installer is idempotent and validates gh-stack\n'
