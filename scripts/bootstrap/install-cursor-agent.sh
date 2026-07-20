#!/usr/bin/env bash
set -euo pipefail

installer_url="${CURSOR_AGENT_INSTALLER_URL:-https://cursor.com/install}"
installer_path="$(mktemp)"
agent_path="$HOME/.local/bin/cursor-agent"

cleanup() {
  rm -f "$installer_path"
}
trap cleanup EXIT

printf 'downloading the official Cursor Agent installer\n'
curl -fsSL "$installer_url" -o "$installer_path"

printf 'installing Cursor Agent for %s\n' "$USER"
bash "$installer_path"

if [ ! -x "$agent_path" ]; then
  printf 'Cursor Agent was not installed at %s\n' "$agent_path" >&2
  exit 1
fi

if [ ! -x "$HOME/.local/bin/agent" ]; then
  printf 'Cursor Agent compatibility command is missing at %s\n' "$HOME/.local/bin/agent" >&2
  exit 1
fi

if [ -r "$HOME/.config/uinaf/devbox.env" ]; then
  env AGENT_CLI_CREDENTIAL_STORE=file "$agent_path" --version
else
  "$agent_path" --version
fi
