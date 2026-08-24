#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
wrapper="$repo_root/scripts/bootstrap/brew-devbox.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
mkdir -p "$tmp_dir/bin"
real_find="$(command -v find)"
export FAKE_REAL_FIND="$real_find"

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
  [ -z "${HOMEBREW_BUNDLE_DOTFILES_PROFILE:-}" ] \
    || printf 'profile=%s\n' "$HOMEBREW_BUNDLE_DOTFILES_PROFILE"
  printf 'arg=%s\n' "$@"
} >>"$FAKE_BREW_LOG"

if [ "${1:-}" = bundle ] && [ "${2:-}" = cleanup ]; then
  shift 2
  cleanup_file=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --file ]; then
      cleanup_file="$2"
      break
    fi
    shift
  done
  [ -n "$cleanup_file" ] || exit 2
  sed -n -E 's/^((brew|cask|tap) ".*)$/cleanup_entry=\1/p' "$cleanup_file" >>"$FAKE_BREW_LOG"
fi

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

cat >"$tmp_dir/bin/find" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [ -n "${FAKE_FIND_FOREIGN_PATH:-}" ]; then
  previous=""
  for argument in "$@"; do
    if [ "$previous" = "!" ] && [ "$argument" = "-uid" ]; then
      printf '%s\n' "$FAKE_FIND_FOREIGN_PATH"
      exit 0
    fi
    previous="$argument"
  done
fi

exec "$FAKE_REAL_FIND" "$@"
EOF
chmod 755 "$tmp_dir/bin/find"
fake_prefix="$tmp_dir/prefix"
mkdir "$fake_prefix"

# Repository fixtures must never read the caller's per-user external-homebrew
# declarations or ambient Homebrew Bundle skip variables.
isolated_external="$tmp_dir/external-homebrew.empty.plist"
/usr/bin/plutil -create xml1 "$isolated_external"
/usr/bin/plutil -insert version -integer 1 "$isolated_external"
/usr/bin/plutil -insert capabilities -array "$isolated_external"
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
  unset HOMEBREW_BUNDLE_DOTFILES_PROFILE
  umask 0077
  PATH="$tmp_dir/bin:$PATH" \
    FAKE_BREW_LOG="$direct_log" \
    FAKE_BREW_PREFIX="$fake_prefix" \
    FAKE_BREW_OUTPUT_DIR="$tmp_dir/output" \
    "$wrapper" upgrade lima usage
)

expected="$(printf 'umask=0027\nno_auto_update=%s\narg=upgrade\narg=lima\narg=usage\n' \
  "${HOMEBREW_NO_AUTO_UPDATE:-}")"
actual="$(cat "$direct_log")"
[ "$actual" = "$expected" ] || fail "wrapper changed arguments or did not set umask 0027"
[ "$(file_mode "$tmp_dir/output/directory")" = 750 ] \
  || fail "wrapper created an unexpected directory mode; expected 750"
[ "$(file_mode "$tmp_dir/output/file")" = 640 ] \
  || fail "wrapper created an unexpected file mode; expected 640"
[ "$(file_mode "$tmp_dir/output/executable")" = 751 ] \
  || fail "wrapper created an unexpected executable mode; expected 751"

mkdir "$fake_prefix/restrictive"
PATH="$tmp_dir/bin:$PATH" \
  FAKE_BREW_LOG="$direct_log" \
  FAKE_BREW_PREFIX="$fake_prefix" \
  FAKE_BREW_RESTRICTIVE_DIR="$fake_prefix/restrictive" \
  "$wrapper" install restrictive
[ "$(file_mode "$fake_prefix/restrictive/directory")" = 750 ] \
  || fail "wrapper repaired a directory to an unexpected mode; expected 750"
[ "$(file_mode "$fake_prefix/restrictive/file")" = 640 ] \
  || fail "wrapper repaired a file to an unexpected mode; expected 640"
[ "$(file_mode "$fake_prefix/restrictive/executable")" = 750 ] \
  || fail "wrapper repaired an executable to an unexpected mode; expected 750"
if [ "$(uname -s)" = Darwin ]; then
  [ "$(file_mode "$fake_prefix/restrictive/link")" = 750 ] \
    || fail "wrapper repaired a symlink to an unexpected mode; expected 750"
fi

chmod 770 "$fake_prefix/restrictive/directory"
PATH="$tmp_dir/bin:$PATH" \
  FAKE_BREW_LOG="$direct_log" \
  FAKE_BREW_PREFIX="$fake_prefix" \
  "$wrapper" --repair-shared-readability
[ "$(file_mode "$fake_prefix/restrictive/directory")" = 750 ] \
  || fail "explicit repair set an unexpected directory mode; expected 750"

refusal_log="$tmp_dir/refusal.log"
: >"$refusal_log"
mkdir "$fake_prefix/group-writable"
chmod 770 "$fake_prefix/group-writable"
set +e
group_writable_output="$(
  PATH="$tmp_dir/bin:$PATH" \
    FAKE_BREW_LOG="$refusal_log" \
    FAKE_BREW_PREFIX="$fake_prefix" \
    "$wrapper" upgrade group-writable 2>&1
)"
group_writable_status=$?
set -e
[ "$group_writable_status" -eq 1 ] \
  || fail "group-writable prefix mutation returned $group_writable_status instead of 1"
printf '%s\n' "$group_writable_output" | grep -Fq 'Homebrew prefix contains group-writable content' \
  || fail "group-writable prefix failure was not actionable"
[ ! -s "$refusal_log" ] || fail "group-writable prefix invoked brew"
chmod 750 "$fake_prefix/group-writable"

set +e
foreign_owner_output="$(
  PATH="$tmp_dir/bin:$PATH" \
    FAKE_BREW_LOG="$refusal_log" \
    FAKE_BREW_PREFIX="$fake_prefix" \
    FAKE_FIND_FOREIGN_PATH="$fake_prefix/foreign-owner" \
    "$wrapper" upgrade foreign-owner 2>&1
)"
foreign_owner_status=$?
set -e
[ "$foreign_owner_status" -eq 1 ] \
  || fail "foreign-owned prefix mutation returned $foreign_owner_status instead of 1"
printf '%s\n' "$foreign_owner_output" | grep -Fq 'Homebrew prefix contains content not owned by uid' \
  || fail "foreign-owned prefix failure was not actionable"
[ ! -s "$refusal_log" ] || fail "foreign-owned prefix invoked brew"

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
  || fail "failed Homebrew mutation repaired a directory to an unexpected mode; expected 750"

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

[ "$(grep -c '^umask=0027$' "$bundle_log")" -eq 3 ] || fail "devbox bundle bypassed the owner-only umask"
[ "$(grep -c '^profile=devbox$' "$bundle_log")" -eq 3 ] || fail "devbox bundle omitted its profile environment"
[ "$(grep -c '^arg=bundle$' "$bundle_log")" -eq 3 ] || fail "devbox bundle did not run all profile layers"
grep -Fqx "arg=$repo_root/Brewfile" "$bundle_log" || fail "shared Brewfile was not bundled"
grep -Fqx "arg=$repo_root/Brewfile.developer" "$bundle_log" || fail "developer Brewfile was not bundled"
grep -Fqx "arg=$repo_root/Brewfile.devbox" "$bundle_log" || fail "devbox Brewfile was not bundled"

stdin_bundle_log="$tmp_dir/stdin-bundle.log"
: >"$stdin_bundle_log"
FAKE_BREW_READ_STDIN=1 run_brew_bundle "$stdin_bundle_log" personal-workstation
[ "$(grep -c '^arg=bundle$' "$stdin_bundle_log")" -eq 4 ] \
  || fail "stdin-consuming brew skipped personal workstation profile layers"
[ "$(grep -c '^profile=personal-workstation$' "$stdin_bundle_log")" -eq 4 ] \
  || fail "personal workstation bundle omitted its profile environment"
for file in Brewfile Brewfile.developer Brewfile.workstation Brewfile.personal; do
  grep -Fqx "arg=$repo_root/$file" "$stdin_bundle_log" \
    || fail "stdin-consuming brew skipped $file"
done

personal_devbox_log="$tmp_dir/personal-devbox.log"
: >"$personal_devbox_log"
run_brew_bundle "$personal_devbox_log" personal-devbox
[ "$(grep -c '^arg=bundle$' "$personal_devbox_log")" -eq 4 ] \
  || fail "personal devbox bundle skipped a profile layer"
[ "$(grep -c '^profile=personal-devbox$' "$personal_devbox_log")" -eq 4 ] \
  || fail "personal devbox bundle omitted its profile environment"
expected_tap_count=0
for file in Brewfile.developer Brewfile.personal; do
  awk '$1 == "tap" && $0 !~ /, trusted: true$/ { exit 1 }' "$repo_root/$file" \
    || fail "$file contains a tap without explicit Bundle trust"
  while IFS= read -r tap; do
    grep -Fqx "arg=$tap" "$personal_devbox_log" \
      || fail "personal devbox bundle did not trust a declared tap"
    expected_tap_count=$((expected_tap_count + 1))
  done < <(awk -F'"' '$1 == "tap " { print $2 }' "$repo_root/$file")
done
[ "$(grep -c '^arg=--tap$' "$personal_devbox_log")" -eq "$expected_tap_count" ] \
  || fail "personal devbox bundle did not trust every declared tap explicitly"
for file in Brewfile Brewfile.developer Brewfile.devbox Brewfile.personal; do
  grep -Fqx "arg=$repo_root/$file" "$personal_devbox_log" \
    || fail "personal devbox bundle skipped $file"
done

assistant_log="$tmp_dir/assistant.log"
: >"$assistant_log"
run_brew_bundle "$assistant_log" assistant
[ "$(grep -c '^umask=0027$' "$assistant_log")" -eq 2 ] || fail "assistant bundle bypassed the owner-only umask"
[ "$(grep -c '^profile=assistant$' "$assistant_log")" -eq 2 ] || fail "assistant bundle omitted its profile environment"
[ "$(grep -c '^arg=bundle$' "$assistant_log")" -eq 2 ] || fail "assistant bundle did not run base and assistant layers"
grep -Fqx "arg=$repo_root/Brewfile" "$assistant_log" || fail "assistant bundle missed the base Brewfile"
grep -Fqx "arg=$repo_root/Brewfile.assistant" "$assistant_log" || fail "assistant bundle missed its profile Brewfile"
if grep -Fqx "arg=$repo_root/Brewfile.developer" "$assistant_log"; then
  fail "assistant bundle installed the developer layer"
fi

shared_log="$tmp_dir/shared.log"
: >"$shared_log"
run_brew_bundle "$shared_log" --shared-only devbox
[ "$(grep -c '^umask=0027$' "$shared_log")" -eq 1 ] || fail "devbox shared-only bundle bypassed the owner-only umask"
[ "$(grep -c '^profile=devbox$' "$shared_log")" -eq 1 ] || fail "shared-only bundle omitted its profile environment"
[ "$(grep -c '^arg=bundle$' "$shared_log")" -eq 1 ] || fail "devbox shared-only bundle did not run exactly once"
grep -Fqx "arg=$repo_root/Brewfile" "$shared_log" || fail "devbox shared-only bundle missed the shared Brewfile"

# A valid workstation-only ambient declaration must not affect the isolated
# repository fixture for a different profile.
host_home="$tmp_dir/host-home"
mkdir -p "$host_home/.config/dotfiles"
host_external="$host_home/.config/dotfiles/external-homebrew.plist"
/usr/bin/plutil -create xml1 "$host_external"
/usr/bin/plutil -insert version -integer 1 "$host_external"
/usr/bin/plutil -insert capabilities -array "$host_external"
/usr/bin/plutil -insert capabilities.0 -dictionary "$host_external"
/usr/bin/plutil -insert capabilities.0.packageType -string cask "$host_external"
/usr/bin/plutil -insert capabilities.0.name -string 1password "$host_external"
/usr/bin/plutil -insert capabilities.0.validator -string command "$host_external"
/usr/bin/plutil -insert capabilities.0.path -string /usr/bin/true "$host_external"
/usr/bin/plutil -insert capabilities.0.arguments -array "$host_external"
chmod 600 "$host_external"
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

cleanup_log="$tmp_dir/cleanup.log"
: >"$cleanup_log"
awk '$1 == "tap" && $0 !~ /, trusted: true$/ { exit 1 }' "$repo_root/Brewfile.assistant" \
  || fail "Brewfile.assistant contains a tap without explicit Bundle trust"
run_brew_bundle "$cleanup_log" --home "$host_home" --cleanup devbox
[ "$(grep -c '^arg=bundle$' "$cleanup_log")" -eq 4 ] \
  || fail "--cleanup did not install the 3 layers before cleaning"
[ "$(grep -c '^profile=devbox$' "$cleanup_log")" -eq 3 ] \
  || fail "--cleanup changed the selected profile for installation"
[ "$(grep -c '^profile=personal-devbox$' "$cleanup_log")" -eq 1 ] \
  || fail "--cleanup did not use the shared host contract"
grep -Fq 'arg=cleanup' "$cleanup_log" || fail "--cleanup did not run brew bundle cleanup"
grep -Fq 'arg=--force' "$cleanup_log" || fail "--cleanup did not force the removal"
grep -Fqx 'cleanup_entry=brew "pi-coding-agent"' "$cleanup_log" \
  || fail "shared cleanup omitted the personal-devbox layer"
grep -Fqx 'cleanup_entry=brew "yt-dlp"' "$cleanup_log" \
  || fail "shared cleanup omitted the assistant layer"
while IFS= read -r tap; do
  grep -Fqx "arg=$tap" "$cleanup_log" \
    || fail "shared cleanup did not trust an assistant tap"
done < <(awk -F'"' '$1 == "tap " { print $2 }' "$repo_root/Brewfile.assistant")
if grep -Fqx 'cleanup_entry=cask "ghostty"' "$cleanup_log"; then
  fail "shared cleanup included the workstation layer"
fi
if ls "$repo_root"/Brewfile.composed.* >/dev/null 2>&1; then
  fail "--cleanup left a composed Brewfile behind"
fi

set +e
"$repo_root/scripts/bootstrap/brew-bundle.sh" --cleanup --shared-only devbox >/dev/null 2>&1
status=$?
set -e
[ "$status" -eq 2 ] || fail "--cleanup with --shared-only was not rejected"

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
    dotfiles_homebrew_bundle_check "$repo_root/Brewfile" devbox
)
grep -Fqx 'no_auto_update=1' "$check_log" \
  || fail "bundle verification allowed Homebrew auto-update"
grep -Fqx 'profile=devbox' "$check_log" \
  || fail "bundle verification omitted its profile environment"

printf 'ok shared Homebrew mutations require the prefix owner and verification stays read-only\n'
