#!/usr/bin/env bash
set -euo pipefail

download_base="${CURSOR_DESKTOP_DOWNLOAD_BASE:-https://api2.cursor.sh/updates/download/golden}"
install_dir="${CURSOR_DESKTOP_INSTALL_DIR:-/Applications}"
machine_arch="${CURSOR_DESKTOP_ARCH:-$(uname -m)}"
cursor_requirement='=anchor apple generic and identifier "com.todesktop.230313mzl4w4u92" and certificate leaf[subject.OU] = "VDXQ22DGB9"'
verify_only=0
temp_dir=""
mount_dir=""
staging_dir=""
mounted=0

usage() {
  cat <<'USAGE'
Usage:
  scripts/bootstrap/install-cursor-desktop.sh [--verify-only]

Downloads Cursor's official macOS disk image, verifies the vendor signature and
Gatekeeper assessment, and installs Cursor.app into /Applications. Existing
installations are validated and left unchanged.

Options:
  --verify-only  Validate the current vendor download without installing it.
USAGE
}

fail() {
  printf 'Cursor desktop install failed: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  if [ "$mounted" -eq 1 ]; then
    hdiutil detach "$mount_dir" -quiet >/dev/null 2>&1 || true
  fi
  if [ -n "$staging_dir" ] && [ -d "$staging_dir" ]; then
    rm -rf "$staging_dir"
  fi
  if [ -n "$temp_dir" ] && [ -d "$temp_dir" ]; then
    rm -rf "$temp_dir"
  fi
}
trap cleanup EXIT

verify_app() {
  local app_path="$1"

  if ! codesign --verify --deep --strict \
    --requirements "$cursor_requirement" "$app_path"; then
    fail "Cursor.app failed vendor code-signature validation; no quarantine attributes were changed"
  fi

  if ! spctl --assess --type execute --verbose=2 "$app_path"; then
    fail "Cursor.app failed the macOS Gatekeeper assessment; refusing to install it"
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --verify-only)
      verify_only=1
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

if [ "$(uname -s)" != "Darwin" ]; then
  fail "this installer supports macOS only"
fi

destination="$install_dir/Cursor.app"
if [ "$verify_only" -eq 0 ] && [ -d "$destination" ]; then
  printf 'validating existing Cursor installation at %s\n' "$destination"
  verify_app "$destination"
  printf 'ok Cursor desktop is already installed and valid\n'
  exit 0
fi
if [ "$verify_only" -eq 0 ] && [ ! -d "$install_dir" ]; then
  fail "install directory does not exist: $install_dir"
fi
if [ "$verify_only" -eq 0 ] && [ ! -w "$install_dir" ]; then
  fail "install directory is not writable: $install_dir"
fi

case "$machine_arch" in
  arm64|aarch64)
    download_arch="darwin-arm64"
    ;;
  x86_64)
    download_arch="darwin-x64"
    ;;
  *)
    fail "unsupported Mac architecture: $machine_arch"
    ;;
esac

download_url="$download_base/$download_arch/cursor/latest"

temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/cursor-desktop.XXXXXX")"
mount_dir="$temp_dir/mount"
dmg_path="$temp_dir/Cursor.dmg"
mkdir -p "$mount_dir"

printf 'downloading Cursor desktop for %s\n' "$machine_arch"
curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 \
  "$download_url" --output "$dmg_path"

printf 'mounting Cursor disk image\n'
hdiutil attach "$dmg_path" -nobrowse -readonly -mountpoint "$mount_dir" >/dev/null
mounted=1

source_app="$mount_dir/Cursor.app"
if [ ! -d "$source_app" ]; then
  fail "the vendor disk image does not contain Cursor.app"
fi

printf 'validating downloaded Cursor application\n'
verify_app "$source_app"

if [ "$verify_only" -eq 1 ]; then
  printf 'ok current Cursor desktop download passed signature and Gatekeeper validation\n'
  exit 0
fi

staging_dir="$(mktemp -d "$install_dir/.cursor-desktop.XXXXXX")"
staged_app="$staging_dir/Cursor.app"
ditto "$source_app" "$staged_app"

printf 'validating staged Cursor application\n'
verify_app "$staged_app"

if [ -e "$destination" ]; then
  fail "Cursor.app appeared at the destination during installation; leaving it unchanged"
fi

mv "$staged_app" "$destination"
printf 'ok installed Cursor desktop at %s\n' "$destination"
