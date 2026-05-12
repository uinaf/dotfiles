#!/usr/bin/env bash
set -euo pipefail

install_dir="${BLACKSMITH_INSTALL_DIR:-$HOME/.local/bin}"
installer_url="https://get.blacksmith.sh"

mkdir -p "$install_dir"

printf 'installing Blacksmith CLI to %s\n' "$install_dir"
curl -fsSL "$installer_url" | BLACKSMITH_INSTALL_DIR="$install_dir" sh

if ! command -v blacksmith >/dev/null 2>&1; then
  printf 'blacksmith was installed to %s but is not on PATH\n' "$install_dir" >&2
  printf 'open a new shell or make sure ~/.local/bin is on PATH\n' >&2
  exit 1
fi

blacksmith --version
printf '%s\n' "run blacksmith auth login to authenticate this machine"
