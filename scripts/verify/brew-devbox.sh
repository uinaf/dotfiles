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

if [ "${1:-}" = "--prefix" ]; then
  printf '%s\n' "$FAKE_BREW_PREFIX"
  exit 0
fi

{
  printf 'umask=%s\n' "$(umask)"
  printf 'no_auto_update=%s\n' "${HOMEBREW_NO_AUTO_UPDATE:-}"
  printf 'arg=%s\n' "$@"
} >>"$FAKE_BREW_LOG"

if [ -n "${FAKE_BREW_OUTPUT_DIR:-}" ]; then
  mkdir "$FAKE_BREW_OUTPUT_DIR/directory"
  : >"$FAKE_BREW_OUTPUT_DIR/file"
  : >"$FAKE_BREW_OUTPUT_DIR/executable"
  chmod a+x "$FAKE_BREW_OUTPUT_DIR/executable"
fi

if [ -n "${FAKE_BREW_RESTRICTIVE_DIR:-}" ]; then
  mkdir "$FAKE_BREW_RESTRICTIVE_DIR/directory"
  : >"$FAKE_BREW_RESTRICTIVE_DIR/file"
  : >"$FAKE_BREW_RESTRICTIVE_DIR/executable"
  chmod 700 "$FAKE_BREW_RESTRICTIVE_DIR/directory"
  chmod 600 "$FAKE_BREW_RESTRICTIVE_DIR/file"
  chmod 700 "$FAKE_BREW_RESTRICTIVE_DIR/executable"
  ln -s file "$FAKE_BREW_RESTRICTIVE_DIR/link"
  chmod -h 700 "$FAKE_BREW_RESTRICTIVE_DIR/link" 2>/dev/null || true
fi

if [ -n "${FAKE_BREW_READ_STDIN:-}" ]; then
  while IFS= read -r _; do :; done
fi

exit "${FAKE_BREW_EXIT:-0}"
EOF
chmod 755 "$tmp_dir/bin/brew"
fake_prefix="$tmp_dir/prefix"
mkdir "$fake_prefix"

# Repository fixtures must never read the caller's per-user external-homebrew
# declarations or ambient Homebrew Bundle skip variables.
isolated_external="$tmp_dir/external-homebrew.empty"
: >"$isolated_external"
chmod 600 "$isolated_external"

run_brew_bundle() {
  local log_file="$1"
  local fixture_home="$HOME"
  shift

  if [ "${1:-}" = "--home" ]; then
    fixture_home="$2"
    shift 2
  fi

  (
    unset HOMEBREW_BUNDLE_BREW_SKIP \
      HOMEBREW_BUNDLE_CASK_SKIP \
      HOMEBREW_BUNDLE_TAP_SKIP \
      HOMEBREW_BUNDLE_MAS_SKIP
    umask 0077
    HOME="$fixture_home" \
      PATH="$tmp_dir/bin:$PATH" \
      FAKE_BREW_LOG="$log_file" \
      FAKE_BREW_PREFIX="$fake_prefix" \
      FAKE_BREW_READ_STDIN="${FAKE_BREW_READ_STDIN:-}" \
      DOTFILES_EXTERNAL_HOMEBREW_FILE="$isolated_external" \
      "$repo_root/scripts/bootstrap/brew-bundle.sh" "$@" >/dev/null
  )
}

direct_log="$tmp_dir/direct.log"
: >"$direct_log"
mkdir "$tmp_dir/output"
(
  umask 0077
  PATH="$tmp_dir/bin:$PATH" \
    FAKE_BREW_LOG="$direct_log" \
    FAKE_BREW_PREFIX="$fake_prefix" \
    FAKE_BREW_OUTPUT_DIR="$tmp_dir/output" \
    "$wrapper" upgrade lima usage
)

expected="$(printf 'umask=0002\nno_auto_update=%s\narg=upgrade\narg=lima\narg=usage\n' \
  "${HOMEBREW_NO_AUTO_UPDATE:-}")"
actual="$(cat "$direct_log")"
[ "$actual" = "$expected" ] || fail "wrapper changed arguments or did not set umask 0002"
[ "$(file_mode "$tmp_dir/output/directory")" = 775 ] || fail "wrapper created a non-shared directory"
[ "$(file_mode "$tmp_dir/output/file")" = 664 ] || fail "wrapper created a non-shared file"
[ "$(file_mode "$tmp_dir/output/executable")" = 775 ] || fail "wrapper created a non-shared executable"

mkdir "$fake_prefix/restrictive"
PATH="$tmp_dir/bin:$PATH" \
  FAKE_BREW_LOG="$direct_log" \
  FAKE_BREW_PREFIX="$fake_prefix" \
  FAKE_BREW_RESTRICTIVE_DIR="$fake_prefix/restrictive" \
  "$wrapper" install restrictive
[ "$(file_mode "$fake_prefix/restrictive/directory")" = 750 ] \
  || fail "wrapper left an owner-only directory unreadable"
[ "$(file_mode "$fake_prefix/restrictive/file")" = 640 ] \
  || fail "wrapper left an owner-only file unreadable"
[ "$(file_mode "$fake_prefix/restrictive/executable")" = 750 ] \
  || fail "wrapper left an owner-only executable unusable"
if [ "$(uname -s)" = Darwin ]; then
  [ "$(file_mode "$fake_prefix/restrictive/link")" = 750 ] \
    || fail "wrapper left an owner-only symlink unreadable"
fi

chmod 700 "$fake_prefix/restrictive/directory"
PATH="$tmp_dir/bin:$PATH" \
  FAKE_BREW_LOG="$direct_log" \
  FAKE_BREW_PREFIX="$fake_prefix" \
  "$wrapper" --repair-shared-readability
[ "$(file_mode "$fake_prefix/restrictive/directory")" = 750 ] \
  || fail "explicit readability repair left an owner-only directory unreadable"

set +e
(
  umask 0077
  mkdir "$fake_prefix/failure-output"
  PATH="$tmp_dir/bin:$PATH" \
    FAKE_BREW_LOG="$direct_log" \
    FAKE_BREW_PREFIX="$fake_prefix" \
    FAKE_BREW_RESTRICTIVE_DIR="$fake_prefix/failure-output" \
    FAKE_BREW_EXIT=37 \
    "$wrapper" failure-path
)
status=$?
set -e
[ "$status" -eq 37 ] || fail "wrapper returned $status instead of the brew exit status"
[ "$(file_mode "$fake_prefix/failure-output/directory")" = 750 ] \
  || fail "failed Homebrew mutation skipped readability repair"

set +e
owner_output="$(
  PATH="$tmp_dir/bin:$PATH" \
  FAKE_BREW_LOG="$direct_log" \
  FAKE_BREW_PREFIX=/ \
    "$wrapper" upgrade 2>&1
)"
owner_status=$?
set -e
if [ "$(id -u)" -ne 0 ]; then
  [ "$owner_status" -eq 1 ] || fail "non-owner mutation returned $owner_status instead of 1"
  printf '%s\n' "$owner_output" | grep -Fq 'Homebrew mutations must run as prefix owner' \
    || fail "non-owner mutation failure was not actionable"
fi

bundle_log="$tmp_dir/bundle.log"
: >"$bundle_log"
run_brew_bundle "$bundle_log" devbox

[ "$(grep -c '^umask=0002$' "$bundle_log")" -eq 3 ] || fail "devbox bundle bypassed the shared umask"
[ "$(grep -c '^arg=bundle$' "$bundle_log")" -eq 3 ] || fail "devbox bundle did not run all profile layers"
grep -Fqx "arg=$repo_root/Brewfile" "$bundle_log" || fail "shared Brewfile was not bundled"
grep -Fqx "arg=$repo_root/Brewfile.developer" "$bundle_log" || fail "developer Brewfile was not bundled"
grep -Fqx "arg=$repo_root/Brewfile.devbox" "$bundle_log" || fail "devbox Brewfile was not bundled"

stdin_bundle_log="$tmp_dir/stdin-bundle.log"
: >"$stdin_bundle_log"
FAKE_BREW_READ_STDIN=1 run_brew_bundle "$stdin_bundle_log" personal
[ "$(grep -c '^arg=bundle$' "$stdin_bundle_log")" -eq 4 ] \
  || fail "stdin-consuming brew skipped personal profile layers"
for file in Brewfile Brewfile.developer Brewfile.workstation Brewfile.personal; do
  grep -Fqx "arg=$repo_root/$file" "$stdin_bundle_log" \
    || fail "stdin-consuming brew skipped $file"
done

assistant_log="$tmp_dir/assistant.log"
: >"$assistant_log"
run_brew_bundle "$assistant_log" assistant
[ "$(grep -c '^umask=0002$' "$assistant_log")" -eq 2 ] || fail "assistant bundle bypassed the shared umask"
[ "$(grep -c '^arg=bundle$' "$assistant_log")" -eq 2 ] || fail "assistant bundle did not run base and assistant layers"
grep -Fqx "arg=$repo_root/Brewfile" "$assistant_log" || fail "assistant bundle missed the base Brewfile"
grep -Fqx "arg=$repo_root/Brewfile.assistant" "$assistant_log" || fail "assistant bundle missed its profile Brewfile"
if grep -Fqx "arg=$repo_root/Brewfile.developer" "$assistant_log"; then
  fail "assistant bundle installed the developer layer"
fi

service_log="$tmp_dir/service.log"
: >"$service_log"
run_brew_bundle "$service_log" service
[ "$(grep -c '^umask=0002$' "$service_log")" -eq 2 ] || fail "service bundle bypassed the shared umask"
[ "$(grep -c '^arg=bundle$' "$service_log")" -eq 2 ] || fail "service bundle did not run base and service layers"
grep -Fqx "arg=$repo_root/Brewfile" "$service_log" || fail "service bundle missed the base Brewfile"
grep -Fqx "arg=$repo_root/Brewfile.service" "$service_log" || fail "service bundle missed its profile Brewfile"
if grep -Fqx "arg=$repo_root/Brewfile.developer" "$service_log"; then
  fail "service bundle installed the developer layer"
fi

shared_log="$tmp_dir/shared.log"
: >"$shared_log"
run_brew_bundle "$shared_log" --shared-only devbox
[ "$(grep -c '^umask=0002$' "$shared_log")" -eq 1 ] || fail "devbox shared-only bundle bypassed the shared umask"
[ "$(grep -c '^arg=bundle$' "$shared_log")" -eq 1 ] || fail "devbox shared-only bundle did not run exactly once"
grep -Fqx "arg=$repo_root/Brewfile" "$shared_log" || fail "devbox shared-only bundle missed the shared Brewfile"

# A valid workstation-only ambient declaration must not affect the isolated
# repository fixture for a different profile.
host_home="$tmp_dir/host-home"
mkdir -p "$host_home/.config/dotfiles"
printf 'cask|1password|command|/usr/bin/true\n' >"$host_home/.config/dotfiles/external-homebrew"
chmod 600 "$host_home/.config/dotfiles/external-homebrew"
set +e
ambient_output="$(
  unset HOMEBREW_BUNDLE_BREW_SKIP \
    HOMEBREW_BUNDLE_CASK_SKIP \
    HOMEBREW_BUNDLE_TAP_SKIP \
    HOMEBREW_BUNDLE_MAS_SKIP \
    DOTFILES_EXTERNAL_HOMEBREW_FILE
  HOME="$host_home" PATH="$tmp_dir/bin:$PATH" \
    FAKE_BREW_LOG="$tmp_dir/ambient.log" \
    FAKE_BREW_PREFIX="$fake_prefix" \
    "$repo_root/scripts/bootstrap/brew-bundle.sh" devbox 2>&1
)"
ambient_status=$?
set -e
[ "$ambient_status" -ne 0 ] || fail "ambient workstation capability did not fail the unisolated path"
printf '%s\n' "$ambient_output" | grep -Fq 'cask 1password is not declared by profile devbox' \
  || fail "ambient workstation capability failure was not profile-specific"

: >"$tmp_dir/isolated-ambient.log"
run_brew_bundle "$tmp_dir/isolated-ambient.log" --home "$host_home" devbox
[ "$(grep -c '^arg=bundle$' "$tmp_dir/isolated-ambient.log")" -eq 3 ] \
  || fail "isolated fixture still read ambient workstation Homebrew capabilities"

set +e
"$repo_root/scripts/bootstrap/brew-bundle.sh" --shared-only >/dev/null 2>&1
status=$?
set -e
[ "$status" -eq 2 ] || fail "ambiguous shared-only bundle did not require a profile"

check_log="$tmp_dir/check.log"
: >"$check_log"
(
  # shellcheck source=scripts/lib/homebrew.sh
  . "$repo_root/scripts/lib/homebrew.sh"
  PATH="$tmp_dir/bin:$PATH" \
  FAKE_BREW_LOG="$check_log" \
  FAKE_BREW_PREFIX="$fake_prefix" \
    dotfiles_homebrew_bundle_check "$repo_root/Brewfile"
)
grep -Fqx 'no_auto_update=1' "$check_log" \
  || fail "bundle verification allowed Homebrew auto-update"

printf 'ok shared Homebrew mutations require the prefix owner and verification stays read-only\n'
