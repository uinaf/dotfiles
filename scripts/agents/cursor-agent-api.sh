#!/usr/bin/env bash
set -euo pipefail

config_path="${LLM_GATEWAY_CONFIG:-$HOME/.config/dotfiles/llm-gateway.json}"
credential_helper="$HOME/.local/libexec/dotfiles/llm-gateway-credential"
acp_auth_filter="$HOME/.local/libexec/dotfiles/cursor-acp-api-key-auth"

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || fail "missing jq"
[ -f "$config_path" ] && [ ! -L "$config_path" ] || fail "missing regular gateway config"
config_mode="$(stat -f '%Lp' "$config_path" 2>/dev/null || stat -c '%a' "$config_path" 2>/dev/null)" \
  || fail "could not inspect gateway config permissions"
[ "$config_mode" = 600 ] || fail "gateway config mode must be 0600"
[ -x "$credential_helper" ] || fail "missing LLM gateway credential helper"
command -v python3 >/dev/null 2>&1 || fail "missing python3"
cursor_agent="$(jq -er '.cursorAgentBin | select(type == "string" and startswith("/"))' "$config_path")" \
  || fail "invalid cursorAgentBin in gateway config"
[ -x "$cursor_agent" ] || fail "Cursor Agent executable is unavailable"

case "${1:-}" in
  login|logout)
    fail "saved-login changes are disabled while the API-key client is enabled; roll back the LLM gateway first"
    ;;
  -v|--version|-h|--help)
    exec "$cursor_agent" "$@"
    ;;
esac

cursor_key="$($credential_helper cursor)"
export CURSOR_API_KEY="$cursor_key"
export AGENT_CLI_CREDENTIAL_STORE=file
unset cursor_key

about_format() {
  shift
  local format=text
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --format=*)
        format="${1#--format=}"
        ;;
      --format)
        format="${2:-}"
        shift
        ;;
      -h|--help)
        printf '%s\n' help
        return 0
        ;;
    esac
    shift
  done
  printf '%s\n' "$format"
}

print_about() {
  local version
  version="$("$cursor_agent" --version 2>/dev/null | head -n 1 | tr -d '\r')"
  version="${version:-unknown}"
  case "$(about_format "$@")" in
    help)
      exec "$cursor_agent" "$@"
      ;;
    json)
      jq -n --arg cliVersion "$version" --arg userEmail "api-key@local" \
        '{cliVersion: $cliVersion, userEmail: $userEmail}'
      ;;
    text)
      printf 'About Cursor CLI\n\n'
      printf 'CLI Version         %s\n' "$version"
      printf 'User Email          api-key@local\n'
      ;;
    *)
      exec "$cursor_agent" "$@"
      ;;
  esac
}

case "${1:-}" in
  status|whoami)
    "$cursor_agent" models >/dev/null
    printf 'API key authenticated\n'
    exit 0
    ;;
  about)
    "$cursor_agent" models >/dev/null
    print_about "$@"
    exit 0
    ;;
esac

for arg in "$@"; do
  if [ "$arg" = acp ]; then
    [ -x "$acp_auth_filter" ] || fail "missing Cursor ACP API-key auth filter"
    exec python3 -u "$acp_auth_filter" "$cursor_agent" "$@"
  fi
done

exec "$cursor_agent" "$@"
