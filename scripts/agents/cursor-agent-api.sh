#!/usr/bin/env bash
set -euo pipefail

config_path="${LLM_CLIENT_CONFIG:-$HOME/.config/dotfiles/llm-client.json}"
credential_helper="$HOME/.local/libexec/dotfiles/llm-client-credential"

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || fail "missing jq"
[ -f "$config_path" ] && [ ! -L "$config_path" ] || fail "missing regular client config"
config_mode="$(stat -f '%Lp' "$config_path" 2>/dev/null || stat -c '%a' "$config_path" 2>/dev/null)" \
  || fail "could not inspect client config permissions"
[ "$config_mode" = 600 ] || fail "client config mode must be 0600"
[ -x "$credential_helper" ] || fail "missing LLM client credential helper"
cursor_agent="$(jq -er '.cursorAgentBin | select(type == "string" and startswith("/"))' "$config_path")" \
  || fail "invalid cursorAgentBin in client config"
[ -x "$cursor_agent" ] || fail "Cursor Agent executable is unavailable"

case "${1:-}" in
  login|logout)
    fail "saved-login changes are disabled while the API-key client is enabled; roll back the LLM client first"
    ;;
  -v|--version|-h|--help)
    exec "$cursor_agent" "$@"
    ;;
esac

cursor_key="$($credential_helper cursor)"
export CURSOR_API_KEY="$cursor_key"
export AGENT_CLI_CREDENTIAL_STORE=file
unset cursor_key

case "${1:-}" in
  status|whoami)
    "$cursor_agent" models >/dev/null
    printf 'API key authenticated\n'
    ;;
  *)
    exec "$cursor_agent" "$@"
    ;;
esac
