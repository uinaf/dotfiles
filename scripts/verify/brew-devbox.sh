#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
wrapper="$repo_root/scripts/bootstrap/brew-devbox.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
mkdir -p "$tmp_dir/bin"

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

file_mode() {
  local path="$1"

  if stat -f '%Lp' "$path" >/dev/null 2>&1; then
    stat -f '%Lp' "$path"
  else
    stat -c '%a' "$path"
  fi
}

cat >"$tmp_dir/bin/brew" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

{
  printf 'umask=%s\n' "$(umask)"
  printf 'arg=%s\n' "$@"
} >>"$FAKE_BREW_LOG"

if [ -n "${FAKE_BREW_OUTPUT_DIR:-}" ]; then
  mkdir "$FAKE_BREW_OUTPUT_DIR/directory"
  : >"$FAKE_BREW_OUTPUT_DIR/file"
  : >"$FAKE_BREW_OUTPUT_DIR/executable"
  chmod a+x "$FAKE_BREW_OUTPUT_DIR/executable"
fi

exit "${FAKE_BREW_EXIT:-0}"
EOF
chmod 755 "$tmp_dir/bin/brew"

direct_log="$tmp_dir/direct.log"
: >"$direct_log"
mkdir "$tmp_dir/output"
(
  umask 0077
  PATH="$tmp_dir/bin:$PATH" \
    FAKE_BREW_LOG="$direct_log" \
    FAKE_BREW_OUTPUT_DIR="$tmp_dir/output" \
    "$wrapper" upgrade lima usage
)

expected="$(printf 'umask=0002\narg=upgrade\narg=lima\narg=usage\n')"
actual="$(cat "$direct_log")"
[ "$actual" = "$expected" ] || fail "wrapper changed arguments or did not set umask 0002"
[ "$(file_mode "$tmp_dir/output/directory")" = 775 ] || fail "wrapper created a non-shared directory"
[ "$(file_mode "$tmp_dir/output/file")" = 664 ] || fail "wrapper created a non-shared file"
[ "$(file_mode "$tmp_dir/output/executable")" = 775 ] || fail "wrapper created a non-shared executable"

set +e
(
  umask 0077
  PATH="$tmp_dir/bin:$PATH" \
    FAKE_BREW_LOG="$direct_log" \
    FAKE_BREW_EXIT=37 \
    "$wrapper" failure-path
)
status=$?
set -e
[ "$status" -eq 37 ] || fail "wrapper returned $status instead of the brew exit status"

bundle_log="$tmp_dir/bundle.log"
: >"$bundle_log"
(
  umask 0077
  PATH="$tmp_dir/bin:$PATH" \
    FAKE_BREW_LOG="$bundle_log" \
    "$repo_root/scripts/bootstrap/brew-bundle.sh" devbox >/dev/null
)

[ "$(grep -c '^umask=0002$' "$bundle_log")" -eq 2 ] || fail "devbox bundle bypassed the shared umask"
[ "$(grep -c '^arg=bundle$' "$bundle_log")" -eq 2 ] || fail "devbox bundle did not run both Brewfiles"
grep -Fqx "arg=$repo_root/Brewfile" "$bundle_log" || fail "shared Brewfile was not bundled"
grep -Fqx "arg=$repo_root/Brewfile.devbox" "$bundle_log" || fail "devbox Brewfile was not bundled"

shared_log="$tmp_dir/shared.log"
: >"$shared_log"
(
  umask 0077
  PATH="$tmp_dir/bin:$PATH" \
    FAKE_BREW_LOG="$shared_log" \
    "$repo_root/scripts/bootstrap/brew-bundle.sh" --shared-only devbox >/dev/null
)
[ "$(grep -c '^umask=0002$' "$shared_log")" -eq 1 ] || fail "devbox shared-only bundle bypassed the shared umask"
[ "$(grep -c '^arg=bundle$' "$shared_log")" -eq 1 ] || fail "devbox shared-only bundle did not run exactly once"
grep -Fqx "arg=$repo_root/Brewfile" "$shared_log" || fail "devbox shared-only bundle missed the shared Brewfile"

set +e
"$repo_root/scripts/bootstrap/brew-bundle.sh" --shared-only >/dev/null 2>&1
status=$?
set -e
[ "$status" -eq 2 ] || fail "ambiguous shared-only bundle did not require a profile"

printf 'ok devbox Homebrew wrapper preserves arguments, status, and shared modes\n'
