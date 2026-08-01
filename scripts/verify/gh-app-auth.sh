#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
installer="$repo_root/scripts/bootstrap/install-gh-app-auth.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

mode_of() {
  if [ "$(uname -s)" = "Darwin" ]; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

mkdir -p "$tmp_dir/bin" "$tmp_dir/archive/fixture-source"
printf 'fixture\n' >"$tmp_dir/archive/fixture-source/README.md"
tar -czf "$tmp_dir/source.tar.gz" -C "$tmp_dir/archive" fixture-source
source_sha256="$(shasum -a 256 "$tmp_dir/source.tar.gz" | awk '{print $1}')"

cat >"$tmp_dir/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf 'curl %s\n' "$*" >>"$FAKE_INSTALL_LOG"
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then
    shift
    output="$1"
  fi
  shift
done
cp "$FAKE_SOURCE_ARCHIVE" "$output"
EOF

cat >"$tmp_dir/bin/mise" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf 'mise %s\n' "$*" >>"$FAKE_INSTALL_LOG"
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    shift
    output="$1"
    break
  fi
  shift
done
[ -n "$output" ] || exit 64
cat >"$output" <<'BINARY'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-} ${2:-}" = "exec --help" ]
BINARY
chmod 0700 "$output"
EOF

cat >"$tmp_dir/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf 'gh %s\n' "$*" >>"$FAKE_INSTALL_LOG"
[ "$*" = "app-auth exec --help" ]
EOF

chmod 0700 "$tmp_dir/bin/curl" "$tmp_dir/bin/mise" "$tmp_dir/bin/gh"

test_home="$tmp_dir/home"
install_dir="$test_home/.local/share/gh/extensions/gh-app-auth"
log="$tmp_dir/install.log"
: >"$log"
HOME="$test_home" \
PATH="$tmp_dir/bin:/usr/bin:/bin" \
FAKE_INSTALL_LOG="$log" \
FAKE_SOURCE_ARCHIVE="$tmp_dir/source.tar.gz" \
GH_APP_AUTH_SOURCE_COMMIT=test-commit \
GH_APP_AUTH_SOURCE_URL=https://example.invalid/source.tar.gz \
GH_APP_AUTH_SOURCE_SHA256="$source_sha256" \
GH_APP_AUTH_GO_VERSION=1.26.5 \
  "$installer" >/dev/null

[ -x "$install_dir/gh-app-auth" ] || fail "installer did not create the extension binary"
[ "$(mode_of "$install_dir/gh-app-auth")" = 700 ] || fail "extension binary mode is not 700"
[ "$(mode_of "$install_dir/.dotfiles-source")" = 600 ] || fail "source marker mode is not 600"
grep -Fq 'curl --fail --location --silent --show-error --retry 3 https://example.invalid/source.tar.gz' "$log" \
  || fail "installer did not fetch the pinned source URL"
grep -Fq 'mise x --yes go@1.26.5 -- go build -trimpath -buildvcs=false -ldflags=-s -w' "$log" \
  || fail "installer did not use the pinned temporary Go toolchain"
grep -Fqx 'gh app-auth exec --help' "$log" || fail "installer did not verify GitHub CLI dispatch"

: >"$log"
HOME="$test_home" \
PATH="$tmp_dir/bin:/usr/bin:/bin" \
FAKE_INSTALL_LOG="$log" \
FAKE_SOURCE_ARCHIVE="$tmp_dir/source.tar.gz" \
GH_APP_AUTH_SOURCE_COMMIT=test-commit \
GH_APP_AUTH_SOURCE_URL=https://example.invalid/source.tar.gz \
GH_APP_AUTH_SOURCE_SHA256="$source_sha256" \
GH_APP_AUTH_GO_VERSION=1.26.5 \
  "$installer" >/dev/null
[ "$(cat "$log")" = 'gh app-auth exec --help' ] \
  || fail "idempotent install performed work beyond runtime verification"

bad_home="$tmp_dir/bad-home"
bad_install_dir="$bad_home/.local/share/gh/extensions/gh-app-auth"
set +e
output="$(
  HOME="$bad_home" \
  PATH="$tmp_dir/bin:/usr/bin:/bin" \
  FAKE_INSTALL_LOG="$log" \
  FAKE_SOURCE_ARCHIVE="$tmp_dir/source.tar.gz" \
  GH_APP_AUTH_SOURCE_COMMIT=test-commit \
  GH_APP_AUTH_SOURCE_URL=https://example.invalid/source.tar.gz \
  GH_APP_AUTH_SOURCE_SHA256=0000000000000000000000000000000000000000000000000000000000000000 \
    "$installer" 2>&1
)"
status=$?
set -e
[ "$status" -eq 1 ] || fail "checksum mismatch returned $status instead of 1"
printf '%s\n' "$output" | grep -Fq 'source checksum mismatch' \
  || fail "checksum mismatch failure was not actionable"
[ ! -e "$bad_install_dir/gh-app-auth" ] || fail "checksum mismatch installed a binary"

printf 'ok assistant gh-app-auth installer is pinned, idempotent, and fail-closed\n'
