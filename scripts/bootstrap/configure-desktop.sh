#!/usr/bin/env bash
set -euo pipefail

check_only=0
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
wallpaper_index="$HOME/Library/Application Support/com.apple.wallpaper/Store/Index.plist"
wallpaper_source="$repo_root/scripts/bootstrap/assets/black-wallpaper.plist"

usage() {
  cat <<'USAGE'
Usage:
  scripts/bootstrap/configure-desktop.sh [--check]

Applies or verifies the owner desktop baseline for a macOS devbox: black system
wallpaper, hidden desktop icons and widgets, compact auto-hiding Dock, no recent
apps, and Google Chrome as the only persistent Dock application.
USAGE
}

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check)
      check_only=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  shift
done

[ "$(uname -s)" = Darwin ] || fail "desktop baseline requires macOS"
[ -d "/Applications/Google Chrome.app" ] || fail "Google Chrome is not installed"

default_equals() {
  local domain="$1"
  local key="$2"
  local expected="$3"
  local actual

  actual="$(defaults read "$domain" "$key" 2>/dev/null || true)"
  [ "$actual" = "$expected" ]
}

wallpaper_is_black() {
  local provider
  local configuration

  [ -f "$wallpaper_index" ] || return 1
  provider="$(
    plutil -extract AllSpacesAndDisplays.Linked.Content.Choices.0.Provider \
      raw -o - "$wallpaper_index" 2>/dev/null || true
  )"
  [ "$provider" = "com.apple.wallpaper.choice.color" ] || return 1

  configuration="$(
    plutil -extract AllSpacesAndDisplays.Linked.Content.Choices.0.Configuration \
      raw -o - "$wallpaper_index" 2>/dev/null \
      | base64 --decode 2>/dev/null \
      | plutil -p - 2>/dev/null || true
  )"
  grep -q '"systemColor"' <<< "$configuration" \
    && grep -q '"black"' <<< "$configuration"
}

dock_has_only_chrome() {
  local apps
  local bundle_count
  local chrome_count

  apps="$(defaults read com.apple.dock persistent-apps 2>/dev/null || true)"
  bundle_count="$(grep -c '"bundle-identifier"' <<< "$apps" || true)"
  chrome_count="$(grep -c '"bundle-identifier" = "com.google.Chrome"' <<< "$apps" || true)"
  [ "$bundle_count" = 1 ] && [ "$chrome_count" = 1 ]
}

dock_array_is_empty() {
  local key="$1"
  local value

  value="$(defaults read com.apple.dock "$key" 2>/dev/null || true)"
  ! grep -q '"tile-data"' <<< "$value"
}

state_is_correct() {
  default_equals com.apple.dock autohide 1 \
    && default_equals com.apple.dock tilesize 31 \
    && default_equals com.apple.dock show-recents 0 \
    && default_equals com.apple.finder CreateDesktop 0 \
    && default_equals com.apple.WindowManager HideDesktop 1 \
    && default_equals com.apple.WindowManager StandardHideWidgets 1 \
    && default_equals com.apple.WindowManager StageManagerHideWidgets 1 \
    && dock_has_only_chrome \
    && dock_array_is_empty persistent-others \
    && dock_array_is_empty recent-apps \
    && wallpaper_is_black
}

if state_is_correct; then
  printf 'desktop baseline ok\n'
  exit 0
fi

if [ "$check_only" -eq 1 ]; then
  fail "desktop baseline drift detected"
fi

defaults write com.apple.dock autohide -bool true
defaults write com.apple.dock tilesize -int 31
defaults write com.apple.dock show-recents -bool false
defaults write com.apple.dock persistent-apps -array '{
  "tile-data" = {
    "bundle-identifier" = "com.google.Chrome";
    "file-data" = {
      "_CFURLString" = "file:///Applications/Google%20Chrome.app/";
      "_CFURLStringType" = 15;
    };
    "file-label" = "Google Chrome";
  };
  "tile-type" = "file-tile";
}'
defaults write com.apple.dock persistent-others -array
defaults write com.apple.dock recent-apps -array

defaults write com.apple.finder CreateDesktop -bool false
defaults write com.apple.WindowManager HideDesktop -bool true
defaults write com.apple.WindowManager StandardHideWidgets -bool true
defaults write com.apple.WindowManager StageManagerHideWidgets -bool true

wallpaper_dir="$(dirname "$wallpaper_index")"
mkdir -p "$wallpaper_dir"
plutil -lint "$wallpaper_source" >/dev/null
install -m 0644 "$wallpaper_source" "$wallpaper_index"

for process_name in Dock Finder WallpaperAgent; do
  killall "$process_name" >/dev/null 2>&1 || true
done

sleep 1
state_is_correct || fail "desktop baseline did not converge"
printf 'desktop baseline applied\n'
