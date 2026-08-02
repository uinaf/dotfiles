#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
installer="$repo_root/scripts/bootstrap/install-cursor-desktop.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
mkdir -p "$tmp_dir/bin" "$tmp_dir/install"

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

cat >"$tmp_dir/bin/uname" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  -s) printf 'Darwin\n' ;;
  -m) printf 'arm64\n' ;;
  *) exit 64 ;;
esac
EOF

cat >"$tmp_dir/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$CURSOR_TEST_LOG"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then
    shift
    : >"$1"
    exit 0
  fi
  shift
done
exit 64
EOF

cat >"$tmp_dir/bin/hdiutil" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'hdiutil %s\n' "$*" >>"$CURSOR_TEST_LOG"
if [ "${1:-}" = "attach" ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "-mountpoint" ]; then
      shift
      mkdir -p "$1/Cursor.app"
      : >"$1/Cursor.app/fixture"
      exit 0
    fi
    shift
  done
  exit 64
fi
EOF

cat >"$tmp_dir/bin/codesign" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'codesign %s\n' "$*" >>"$CURSOR_TEST_LOG"
[ "${CURSOR_TEST_CODESIGN_FAIL:-0}" -eq 0 ]
EOF

cat >"$tmp_dir/bin/spctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'spctl %s\n' "$*" >>"$CURSOR_TEST_LOG"
[ "${CURSOR_TEST_SPCTL_FAIL:-0}" -eq 0 ]
EOF

cat >"$tmp_dir/bin/ditto" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'ditto %s\n' "$*" >>"$CURSOR_TEST_LOG"
cp -R "$1" "$2"
EOF

chmod 755 "$tmp_dir/bin/"*

run_installer() {
  PATH="$tmp_dir/bin:/usr/bin:/bin" \
    CURSOR_TEST_LOG="$tmp_dir/run.log" \
    CURSOR_DESKTOP_ARCH=arm64 \
    CURSOR_DESKTOP_DOWNLOAD_BASE=https://example.com/cursor \
    CURSOR_DESKTOP_INSTALL_DIR="$tmp_dir/install" \
    "$installer" "$@"
}

: >"$tmp_dir/run.log"
run_installer >/dev/null
[ -d "$tmp_dir/install/Cursor.app" ] || fail "valid Cursor app was not installed"
grep -Fq 'https://example.com/cursor/darwin-arm64/cursor/latest --output' "$tmp_dir/run.log" \
  || fail "installer did not map arm64 to the configured vendor endpoint"
[ "$(grep -c '^codesign ' "$tmp_dir/run.log")" -eq 2 ] \
  || fail "installer did not verify both downloaded and staged apps"
[ "$(grep -c '^spctl ' "$tmp_dir/run.log")" -eq 2 ] \
  || fail "installer did not assess both downloaded and staged apps with Gatekeeper"
if grep -Eq 'xattr|no-quarantine' "$tmp_dir/run.log"; then
  fail "installer bypassed macOS quarantine"
fi

: >"$tmp_dir/run.log"
run_installer >/dev/null
if grep -q '^curl ' "$tmp_dir/run.log"; then
  fail "installer downloaded an artifact over an existing valid app"
fi

rm -rf "$tmp_dir/install/Cursor.app"
: >"$tmp_dir/run.log"
set +e
output="$(CURSOR_TEST_CODESIGN_FAIL=1 run_installer 2>&1)"
status=$?
set -e
[ "$status" -eq 1 ] || fail "invalid signature returned $status instead of 1"
printf '%s\n' "$output" | grep -Fq 'failed vendor code-signature validation' \
  || fail "invalid-signature failure was not actionable"
[ ! -e "$tmp_dir/install/Cursor.app" ] || fail "invalid app reached the install directory"
if grep -q '^ditto ' "$tmp_dir/run.log"; then
  fail "invalid app was copied into staging"
fi

: >"$tmp_dir/run.log"
set +e
output="$(CURSOR_TEST_SPCTL_FAIL=1 run_installer 2>&1)"
status=$?
set -e
[ "$status" -eq 1 ] || fail "Gatekeeper rejection returned $status instead of 1"
printf '%s\n' "$output" | grep -Fq 'failed the macOS Gatekeeper assessment' \
  || fail "Gatekeeper failure was not actionable"
[ ! -e "$tmp_dir/install/Cursor.app" ] || fail "Gatekeeper-rejected app was installed"

: >"$tmp_dir/run.log"
run_installer --verify-only >/dev/null
[ ! -e "$tmp_dir/install/Cursor.app" ] || fail "verify-only mode installed the app"
if grep -q '^ditto ' "$tmp_dir/run.log"; then
  fail "verify-only mode copied the app into staging"
fi

printf 'ok Cursor desktop installer validates vendor identity and Gatekeeper before installation\n'
