#!/usr/bin/env bash
set -euo pipefail

archive="${1:-}"

if [ -z "$archive" ]; then
  printf 'usage: %s /path/to/tizen-migration.tar.gz\n' "$0" >&2
  exit 2
fi

if [ ! -f "$archive" ]; then
  printf 'archive not found: %s\n' "$archive" >&2
  exit 1
fi

printf 'This will restore Tizen cert/profile state into %s\n' "$HOME"
printf 'Archive: %s\n' "$archive"
printf 'Press Enter to continue, or Ctrl-C to stop. '
read -r _

tar -C "$HOME" -xzf "$archive"

mkdir -p "$HOME/.local/bin"
if [ -x "$HOME/tizen-studio/tools/ide/bin/tizen" ]; then
  ln -sf "$HOME/tizen-studio/tools/ide/bin/tizen" "$HOME/.local/bin/tizen"
fi
if [ -x "$HOME/tizen-studio/tools/ide/bin/tizen.sh" ]; then
  ln -sf "$HOME/tizen-studio/tools/ide/bin/tizen.sh" "$HOME/.local/bin/tizen.sh"
fi
if [ -x "$HOME/tizen-studio/tools/sdb" ]; then
  ln -sf "$HOME/tizen-studio/tools/sdb" "$HOME/.local/bin/sdb"
fi

printf 'restored Tizen state\n'
printf 'verify with:\n'
printf '  tizen version\n'
printf '  sdb version\n'
