#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
mkdir -p "$tmp_dir/bin"

# shellcheck source=scripts/lib/profile.sh
. "$repo_root/scripts/lib/profile.sh"
# shellcheck source=scripts/lib/homebrew.sh
. "$repo_root/scripts/lib/homebrew.sh"

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

cat >"$tmp_dir/bin/managed-tool" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$MANAGED_TOOL_LOG"
exit "${MANAGED_TOOL_EXIT:-0}"
EOF
chmod 755 "$tmp_dir/bin/managed-tool"

managed_log="$tmp_dir/managed.log"
: >"$managed_log"
external_file="$tmp_dir/external-homebrew"
printf 'brew|git|command|%s|--version\ncask|google-chrome|command|%s|--version\n' \
  "$tmp_dir/bin/managed-tool" "$tmp_dir/bin/managed-tool" >"$external_file"
chmod 600 "$external_file"

chmod 777 "$tmp_dir/bin/managed-tool"
if (
  MANAGED_TOOL_LOG="$managed_log" DOTFILES_EXTERNAL_HOMEBREW_FILE="$external_file" \
    dotfiles_homebrew_configure_external_capabilities "$repo_root" workstation >/dev/null 2>&1
); then
  fail "group- or world-writable external command was accepted"
fi
chmod 755 "$tmp_dir/bin/managed-tool"

(
  unset HOMEBREW_BUNDLE_BREW_SKIP HOMEBREW_BUNDLE_CASK_SKIP
  MANAGED_TOOL_LOG="$managed_log" \
    DOTFILES_EXTERNAL_HOMEBREW_FILE="$external_file" \
    dotfiles_homebrew_configure_external_capabilities "$repo_root" workstation >/dev/null
  [ "$HOMEBREW_BUNDLE_BREW_SKIP" = git ] || fail "external formula was not skipped"
  [ "$HOMEBREW_BUNDLE_CASK_SKIP" = google-chrome ] || fail "external cask was not skipped"
)
[ "$(grep -c '^--version$' "$managed_log")" -eq 2 ] || fail "external command checks did not execute"

if (
  HOMEBREW_BUNDLE_BREW_SKIP=git DOTFILES_EXTERNAL_HOMEBREW_FILE="$tmp_dir/missing" \
    dotfiles_homebrew_configure_external_capabilities "$repo_root" workstation >/dev/null 2>&1
); then
  fail "ambient Homebrew Bundle skip was accepted without validation"
fi

printf 'brew|not-declared|command|%s|--version\n' "$tmp_dir/bin/managed-tool" >"$external_file"
if (
  MANAGED_TOOL_LOG="$managed_log" DOTFILES_EXTERNAL_HOMEBREW_FILE="$external_file" \
    dotfiles_homebrew_configure_external_capabilities "$repo_root" workstation >/dev/null 2>&1
); then
  fail "undeclared external package was accepted"
fi

printf 'brew|git|command|%s|--version\n' "$tmp_dir/bin/managed-tool" >"$external_file"
chmod 666 "$external_file"
if (
  MANAGED_TOOL_LOG="$managed_log" DOTFILES_EXTERNAL_HOMEBREW_FILE="$external_file" \
    dotfiles_homebrew_configure_external_capabilities "$repo_root" workstation >/dev/null 2>&1
); then
  fail "writable external capability file was accepted"
fi
chmod 600 "$external_file"

printf 'brew|git|command|%s|--version\nbrew|git|command|%s|--version\n' \
  "$tmp_dir/bin/managed-tool" "$tmp_dir/bin/managed-tool" >"$external_file"
if (
  MANAGED_TOOL_LOG="$managed_log" DOTFILES_EXTERNAL_HOMEBREW_FILE="$external_file" \
    dotfiles_homebrew_configure_external_capabilities "$repo_root" workstation >/dev/null 2>&1
); then
  fail "duplicate external capability was accepted"
fi

printf 'brew|git|command|%s|--version\n' "$tmp_dir/bin/managed-tool" >"$external_file"
if (
  MANAGED_TOOL_LOG="$managed_log" MANAGED_TOOL_EXIT=23 \
    DOTFILES_EXTERNAL_HOMEBREW_FILE="$external_file" \
    dotfiles_homebrew_configure_external_capabilities "$repo_root" workstation >/dev/null 2>&1
); then
  fail "blocked external command was accepted"
fi

app_path="$tmp_dir/Managed Browser.app"
mkdir -p "$app_path/Contents"
cat >"$app_path/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.example.ManagedBrowser</string>
</dict>
</plist>
EOF
cat >"$tmp_dir/bin/codesign" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "--verify" ]; then
  exit "${MANAGED_CODESIGN_VERIFY_EXIT:-0}"
fi
printf 'TeamIdentifier=MANAGEDTEAM\n' >&2
EOF
chmod 755 "$tmp_dir/bin/codesign"
dotfiles_homebrew_codesign() {
  "$tmp_dir/bin/codesign" "$@"
}
printf 'cask|google-chrome|bundle|%s|com.example.ManagedBrowser|MANAGEDTEAM\n' "$app_path" >"$external_file"
(
  unset HOMEBREW_BUNDLE_CASK_SKIP
  DOTFILES_EXTERNAL_HOMEBREW_FILE="$external_file" \
    dotfiles_homebrew_configure_external_capabilities "$repo_root" workstation >/dev/null
  [ "$HOMEBREW_BUNDLE_CASK_SKIP" = google-chrome ] || fail "validated bundle was not skipped"
)

printf 'cask|google-chrome|bundle|%s|com.example.ManagedBrowser|WRONGTEAM\n' "$app_path" >"$external_file"
if (
  DOTFILES_EXTERNAL_HOMEBREW_FILE="$external_file" \
    dotfiles_homebrew_configure_external_capabilities "$repo_root" workstation >/dev/null 2>&1
); then
  fail "bundle with the wrong signing team was accepted"
fi

printf 'cask|google-chrome|bundle|%s|com.example.WrongBrowser|MANAGEDTEAM\n' "$app_path" >"$external_file"
if (
  DOTFILES_EXTERNAL_HOMEBREW_FILE="$external_file" \
    dotfiles_homebrew_configure_external_capabilities "$repo_root" workstation >/dev/null 2>&1
); then
  fail "bundle with the wrong identifier was accepted"
fi

symlinked_app="$tmp_dir/Symlinked Browser.app"
ln -s "$app_path" "$symlinked_app"
printf 'cask|google-chrome|bundle|%s|com.example.ManagedBrowser|MANAGEDTEAM\n' "$symlinked_app" >"$external_file"
if (
  DOTFILES_EXTERNAL_HOMEBREW_FILE="$external_file" \
    dotfiles_homebrew_configure_external_capabilities "$repo_root" workstation >/dev/null 2>&1
); then
  fail "symlinked external bundle was accepted"
fi

printf 'cask|google-chrome|bundle|%s|com.example.ManagedBrowser|MANAGEDTEAM\n' "$app_path" >"$external_file"
if (
  MANAGED_CODESIGN_VERIFY_EXIT=1 DOTFILES_EXTERNAL_HOMEBREW_FILE="$external_file" \
    dotfiles_homebrew_configure_external_capabilities "$repo_root" workstation >/dev/null 2>&1
); then
  fail "bundle with a failed signature check was accepted"
fi

printf 'cask|google-chrome|bundle|%s|com.example.ManagedBrowser|not set\n' "$app_path" >"$external_file"
if (
  DOTFILES_EXTERNAL_HOMEBREW_FILE="$external_file" \
    dotfiles_homebrew_configure_external_capabilities "$repo_root" workstation >/dev/null 2>&1
); then
  fail "bundle without a concrete signing team was accepted"
fi

printf 'ok external Homebrew capabilities are explicit, validated, and fail closed\n'
