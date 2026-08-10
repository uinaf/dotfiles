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

dotfiles_homebrew_external_entry_declared() {
  case "$2|$3|$4" in
    workstation\|brew\|git | workstation\|cask\|google-chrome | personal-workstation\|cask\|tailscale-app)
      return 0
      ;;
    *) return 1 ;;
  esac
}

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

new_config() {
  local file="$1"

  /usr/bin/plutil -create xml1 "$file"
  /usr/bin/plutil -insert version -integer 1 "$file"
  /usr/bin/plutil -insert capabilities -array "$file"
  chmod 600 "$file"
}

add_command() {
  local file="$1"
  local package_type="$2"
  local package_name="$3"
  local target="$4"
  local index
  local argument_index=0
  shift 4

  index="$(/usr/bin/plutil -extract capabilities raw -expect array "$file")"
  /usr/bin/plutil -insert "capabilities.$index" -dictionary "$file"
  /usr/bin/plutil -insert "capabilities.$index.packageType" -string "$package_type" "$file"
  /usr/bin/plutil -insert "capabilities.$index.name" -string "$package_name" "$file"
  /usr/bin/plutil -insert "capabilities.$index.validator" -string command "$file"
  /usr/bin/plutil -insert "capabilities.$index.path" -string "$target" "$file"
  /usr/bin/plutil -insert "capabilities.$index.arguments" -array "$file"
  for argument in "$@"; do
    /usr/bin/plutil -insert "capabilities.$index.arguments.$argument_index" -string "$argument" "$file"
    argument_index=$((argument_index + 1))
  done
}

add_bundle() {
  local file="$1"
  local package_name="$2"
  local target="$3"
  local bundle_identifier="$4"
  local team_identifier="$5"
  local index

  index="$(/usr/bin/plutil -extract capabilities raw -expect array "$file")"
  /usr/bin/plutil -insert "capabilities.$index" -dictionary "$file"
  /usr/bin/plutil -insert "capabilities.$index.packageType" -string cask "$file"
  /usr/bin/plutil -insert "capabilities.$index.name" -string "$package_name" "$file"
  /usr/bin/plutil -insert "capabilities.$index.validator" -string bundle "$file"
  /usr/bin/plutil -insert "capabilities.$index.path" -string "$target" "$file"
  /usr/bin/plutil -insert "capabilities.$index.bundleIdentifier" -string "$bundle_identifier" "$file"
  /usr/bin/plutil -insert "capabilities.$index.teamIdentifier" -string "$team_identifier" "$file"
}

assert_rejected() {
  local label="$1"
  local file="$2"
  local profile="${3:-workstation}"

  if (
    MANAGED_TOOL_LOG="$managed_log" DOTFILES_EXTERNAL_HOMEBREW_FILE="$file" \
      dotfiles_homebrew_configure_external_capabilities "$repo_root" "$profile" >/dev/null 2>&1
  ); then
    fail "$label was accepted"
  fi
}

unset HOMEBREW_BUNDLE_BREW_SKIP \
  HOMEBREW_BUNDLE_CASK_SKIP \
  HOMEBREW_BUNDLE_TAP_SKIP \
  HOMEBREW_BUNDLE_MAS_SKIP

managed_tool="$tmp_dir/bin/managed tool | dünya"
cat >"$managed_tool" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >>"$MANAGED_TOOL_LOG"
exit "${MANAGED_TOOL_EXIT:-0}"
EOF
chmod 755 "$managed_tool"
managed_log="$tmp_dir/managed.log"
: >"$managed_log"
external_file="$tmp_dir/external-homebrew.plist"

new_config "$external_file"
add_command "$external_file" brew git "$managed_tool" '--label=hello | dünya' ' spaced value '
add_command "$external_file" cask google-chrome "$managed_tool" --version
(
  unset HOMEBREW_BUNDLE_BREW_SKIP HOMEBREW_BUNDLE_CASK_SKIP
  MANAGED_TOOL_LOG="$managed_log" DOTFILES_EXTERNAL_HOMEBREW_FILE="$external_file" \
    dotfiles_homebrew_configure_external_capabilities "$repo_root" workstation >/dev/null
  [ "$HOMEBREW_BUNDLE_BREW_SKIP" = git ] || fail "external formula was not skipped"
  [ "$HOMEBREW_BUNDLE_CASK_SKIP" = google-chrome ] || fail "external cask was not skipped"
)
grep -Fqx -- '--label=hello | dünya' "$managed_log" || fail "delimiter or Unicode argument changed"
grep -Fqx ' spaced value ' "$managed_log" || fail "whitespace argument changed"

chmod 777 "$managed_tool"
assert_rejected "unsafe command mode" "$external_file"
chmod 755 "$managed_tool"

new_config "$external_file"
add_command "$external_file" cask tailscale-app "$managed_tool" --version
(
  unset HOMEBREW_BUNDLE_CASK_SKIP
  MANAGED_TOOL_LOG="$managed_log" DOTFILES_EXTERNAL_HOMEBREW_FILE="$external_file" \
    dotfiles_homebrew_configure_external_capabilities "$repo_root" personal-workstation >/dev/null
  [ "$HOMEBREW_BUNDLE_CASK_SKIP" = tailscale-app ] || fail "conditional cask was not skipped"
)
assert_rejected "workstation-only cask for personal-devbox" "$external_file" personal-devbox

new_config "$external_file"
add_command "$external_file" brew not-declared "$managed_tool" --version
assert_rejected "undeclared package" "$external_file"

new_config "$external_file"
add_command "$external_file" brew git "$managed_tool" --version
chmod 666 "$external_file"
assert_rejected "unsafe config mode" "$external_file"
chmod 600 "$external_file"

(
  config_uid="$(id -u)"
  dotfiles_homebrew_path_uid() {
    if [ "$1" = "$external_file" ]; then
      printf '%s\n' "$((config_uid + 1))"
    else
      stat -f '%u' "$1"
    fi
  }
  dotfiles_homebrew_path_uid "$external_file" >/dev/null
  assert_rejected "wrong config owner" "$external_file"
)

regular_link="$tmp_dir/regular-link.plist"
ln -s "$external_file" "$regular_link"
assert_rejected "regular config symlink" "$regular_link"
dangling_link="$tmp_dir/dangling-link.plist"
ln -s "$tmp_dir/missing.plist" "$dangling_link"
assert_rejected "dangling config symlink" "$dangling_link"

printf '<plist><dict>' >"$external_file"
chmod 600 "$external_file"
assert_rejected "malformed plist" "$external_file"

cat >"$external_file" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><array/></plist>
EOF
assert_rejected "array root" "$external_file"

new_config "$external_file"
/usr/bin/plutil -replace version -integer 2 "$external_file"
assert_rejected "unsupported version" "$external_file"

new_config "$external_file"
add_command "$external_file" brew git "$managed_tool" --version
/usr/bin/plutil -replace capabilities.0.name -bool true "$external_file"
assert_rejected "wrong field type" "$external_file"

new_config "$external_file"
add_command "$external_file" brew git "$managed_tool" --version
add_command "$external_file" brew git "$managed_tool" --help
assert_rejected "duplicate package record" "$external_file"

new_config "$external_file"
add_command "$external_file" brew git "$managed_tool" one two three four
assert_rejected "four command arguments" "$external_file"

new_config "$external_file"
add_command "$external_file" brew git "$managed_tool" --version
if MANAGED_TOOL_LOG="$managed_log" MANAGED_TOOL_EXIT=23 DOTFILES_EXTERNAL_HOMEBREW_FILE="$external_file" \
  dotfiles_homebrew_configure_external_capabilities "$repo_root" workstation >/dev/null 2>&1; then
  fail "failed external command was accepted"
fi

app_path="$tmp_dir/Managed Browser | dünya.app"
mkdir -p "$app_path/Contents"
cat >"$app_path/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.ManagedBrowser</string></dict></plist>
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

new_config "$external_file"
add_bundle "$external_file" google-chrome "$app_path" com.example.ManagedBrowser MANAGEDTEAM
(
  unset HOMEBREW_BUNDLE_CASK_SKIP
  DOTFILES_EXTERNAL_HOMEBREW_FILE="$external_file" \
    dotfiles_homebrew_configure_external_capabilities "$repo_root" workstation >/dev/null
  [ "$HOMEBREW_BUNDLE_CASK_SKIP" = google-chrome ] || fail "validated bundle was not skipped"
)

new_config "$external_file"
add_bundle "$external_file" google-chrome "$app_path" com.example.ManagedBrowser WRONGTEAM
assert_rejected "wrong signing team" "$external_file"

new_config "$external_file"
add_bundle "$external_file" google-chrome "$app_path" com.example.WrongBrowser MANAGEDTEAM
assert_rejected "wrong bundle identifier" "$external_file"

new_config "$external_file"
add_bundle "$external_file" google-chrome "$app_path" com.example.ManagedBrowser MANAGEDTEAM
if (
  MANAGED_CODESIGN_VERIFY_EXIT=1 DOTFILES_EXTERNAL_HOMEBREW_FILE="$external_file" \
    dotfiles_homebrew_configure_external_capabilities "$repo_root" workstation >/dev/null 2>&1
); then
  fail "failed bundle signature was accepted"
fi

symlinked_app="$tmp_dir/Symlinked Browser.app"
ln -s "$app_path" "$symlinked_app"
new_config "$external_file"
add_bundle "$external_file" google-chrome "$symlinked_app" com.example.ManagedBrowser MANAGEDTEAM
assert_rejected "symlinked bundle" "$external_file"

legacy_home="$tmp_dir/legacy-home"
mkdir -p "$legacy_home/.config/dotfiles"
printf 'brew|git|command|%s|--version\n' "$managed_tool" >"$legacy_home/.config/dotfiles/external-homebrew"
chmod 600 "$legacy_home/.config/dotfiles/external-homebrew"
legacy_error="$tmp_dir/legacy-error"
if HOME="$legacy_home" dotfiles_homebrew_configure_external_capabilities "$repo_root" workstation 2>"$legacy_error"; then
  fail "legacy pipe-delimited file was accepted"
fi
grep -Fq 'migrate it to' "$legacy_error" || fail "legacy format failure did not explain migration"

if HOMEBREW_BUNDLE_BREW_SKIP=git DOTFILES_EXTERNAL_HOMEBREW_FILE="$tmp_dir/missing" \
  dotfiles_homebrew_configure_external_capabilities "$repo_root" workstation >/dev/null 2>&1; then
  fail "ambient Homebrew Bundle skip was accepted without validation"
fi

printf 'ok external Homebrew XML plist is typed, unambiguous, and fail closed\n'
