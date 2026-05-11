#!/usr/bin/env bash
set -euo pipefail

version="${TIZEN_SDK_VERSION:-10.0}"
studio_home="${TIZEN_STUDIO_HOME:-$HOME/tizen-studio}"
download_dir="${TIZEN_DOWNLOAD_DIR:-$HOME/Downloads/tizen-install}"
installer_name="web-cli_Tizen_SDK_${version}_macos-64.bin"
installer_url="${TIZEN_INSTALLER_URL:-https://download.tizen.org/sdk/Installer/tizen-sdk_${version}/${installer_name}}"
installer_path="$download_dir/$installer_name"
package_manager="$studio_home/package-manager/package-manager-cli.bin"
packages="${TIZEN_PACKAGES:-}"
show_packages=0
java_tool="${TIZEN_JAVA_TOOL:-java@temurin-21}"
package_proxy="${TIZEN_PACKAGE_PROXY:-direct}"

usage() {
  cat <<EOF
usage: $0 [--show-pkgs] [--packages package1,package2]

Environment:
  TIZEN_SDK_VERSION      default: 10.0
  TIZEN_STUDIO_HOME      default: \$HOME/tizen-studio
  TIZEN_DOWNLOAD_DIR     default: \$HOME/Downloads/tizen-install
  TIZEN_INSTALLER_URL    default: official Tizen SDK CLI installer URL
  TIZEN_PACKAGES         optional comma-separated package list
  TIZEN_DOWNLOADER       default: aria2c when available, otherwise curl
  TIZEN_JAVA_TOOL        mise Java tool, default: java@temurin-21
  TIZEN_PACKAGE_PROXY    package-manager proxy mode, default: direct
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --show-pkgs)
      show_packages=1
      shift
      ;;
    --packages)
      if [ -z "${2:-}" ]; then
        printf '%s\n' '--packages requires a comma-separated package list' >&2
        exit 2
      fi
      packages="$2"
      shift 2
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  printf 'this installer script is currently macOS-only\n' >&2
  exit 1
fi

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

link_tool() {
  local source="$1"
  local target="$2"

  if [ -x "$source" ]; then
    ln -sf "$source" "$target"
    printf 'linked %s -> %s\n' "$target" "$source"
  fi
}

install_rosetta_if_needed() {
  if [ "$(uname -m)" != "arm64" ]; then
    return
  fi

  if pkgutil --pkg-info com.apple.pkg.RosettaUpdateAuto >/dev/null 2>&1; then
    printf 'Rosetta is already installed\n'
    return
  fi

  printf 'installing Rosetta for Tizen x86_64 tools\n'
  softwareupdate --install-rosetta --agree-to-license
}

setup_java() {
  local mise_bin=""

  if command -v mise >/dev/null 2>&1; then
    mise_bin="$(command -v mise)"
  elif [ -x /opt/homebrew/bin/mise ]; then
    mise_bin="/opt/homebrew/bin/mise"
  fi

  if [ -n "$mise_bin" ]; then
    "$mise_bin" install "$java_tool"
    JAVA_HOME="$("$mise_bin" where "$java_tool")"
    export JAVA_HOME
    PATH="$JAVA_HOME/bin:$PATH"
    export PATH
    printf 'using %s at %s\n' "$java_tool" "$JAVA_HOME"
    java -version
    return
  fi

  printf 'mise not found; falling back to system java\n' >&2
  java -version
}

download_installer() {
  if [ "${TIZEN_DOWNLOADER:-}" = "curl" ]; then
    require curl
    printf 'downloading with curl resume/retry support\n'
    curl -fL -C - --retry 20 --retry-delay 5 --retry-all-errors -o "$installer_path" "$installer_url"
    return
  fi

  if [ "${TIZEN_DOWNLOADER:-}" = "aria2c" ] || command -v aria2c >/dev/null 2>&1; then
    require aria2c
    printf 'downloading with aria2c resume/retry support\n'
    aria2c \
      --continue=true \
      --max-tries=0 \
      --retry-wait=5 \
      --timeout=30 \
      --connect-timeout=30 \
      --summary-interval=30 \
      --dir "$download_dir" \
      --out "$installer_name" \
      "$installer_url"
    return
  fi

  require curl
  printf 'aria2c not found; downloading with curl resume/retry support\n'
  curl -fL -C - --retry 20 --retry-delay 5 --retry-all-errors -o "$installer_path" "$installer_url"
}

mkdir -p "$download_dir" "$HOME/.local/bin"
install_rosetta_if_needed
setup_java

if [ ! -x "$package_manager" ]; then
  if [ -e "$studio_home" ]; then
    printf 'Tizen Studio path exists but package manager is missing: %s\n' "$studio_home" >&2
    printf 'move or remove that directory, then rerun this script\n' >&2
    exit 1
  fi

  printf 'installer: %s\n' "$installer_path"
  download_installer

  chmod +x "$installer_path"
  xattr -dr com.apple.quarantine "$installer_path" 2>/dev/null || true
  printf 'installing Tizen SDK %s into %s\n' "$version" "$studio_home"
  "$installer_path" --accept-license --no-java-check "$studio_home"
else
  printf 'Tizen package manager already exists at %s\n' "$package_manager"
fi

if [ ! -x "$package_manager" ]; then
  printf 'package manager not found after install: %s\n' "$package_manager" >&2
  exit 1
fi

link_tool "$studio_home/tools/ide/bin/tizen" "$HOME/.local/bin/tizen"
link_tool "$studio_home/tools/ide/bin/tizen.sh" "$HOME/.local/bin/tizen.sh"
link_tool "$studio_home/tools/sdb" "$HOME/.local/bin/sdb"
link_tool "$package_manager" "$HOME/.local/bin/package-manager-cli"

printf 'clearing stale Tizen package-manager JDK cache\n'
rm -rf "$HOME/.package-manager/jdk"

if [ -n "$packages" ]; then
  printf 'installing Tizen packages: %s\n' "$packages"
  "$package_manager" install --accept-license --no-java-check --proxy "$package_proxy" "$packages"
fi

printf '\nVerifying Tizen tools:\n'
"$HOME/.local/bin/tizen" version
"$HOME/.local/bin/sdb" version
"$package_manager" --help >/dev/null
"$package_manager" show-info >/dev/null

if [ "$show_packages" -eq 1 ]; then
  printf '\nAvailable packages:\n'
  printf 'warning: Samsung package catalog lookup can be slow or hang on extension downloads\n' >&2
  "$package_manager" show-pkgs --proxy "$package_proxy" --tree
fi

printf '\nTizen SDK install step finished.\n'
printf 'Package catalog lookup is intentionally skipped by default; use --show-pkgs only when needed.\n'
printf 'Next, restore cert/profile state if needed:\n'
printf '  ./scripts/tizen-restore.sh ~/Desktop/tizen-certs-YYYYMMDDHHMMSS.tar.gz\n'
