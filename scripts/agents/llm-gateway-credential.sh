#!/usr/bin/env bash
set -euo pipefail

config_path="${LLM_GATEWAY_CONFIG:-$HOME/.config/dotfiles/llm-gateway.json}"

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

[ "$#" -eq 1 ] || fail "usage: llm-gateway-credential.sh cursor|gateway"
case "$1" in
  cursor) field=CURSOR_API_KEY ;;
  gateway) field=CLIPROXYAPI_CLIENT_API_KEY ;;
  *) fail "usage: llm-gateway-credential.sh cursor|gateway" ;;
esac

command -v jq >/dev/null 2>&1 || fail "missing jq"
command -v sops >/dev/null 2>&1 || fail "missing sops"
[ -f "$config_path" ] && [ ! -L "$config_path" ] || fail "missing regular gateway config"
config_mode="$(stat -f '%Lp' "$config_path" 2>/dev/null || stat -c '%a' "$config_path" 2>/dev/null)" \
  || fail "could not inspect gateway config permissions"
[ "$config_mode" = 600 ] || fail "gateway config mode must be 0600"

secret_file="$(jq -er '.secretFile | select(type == "string" and startswith("/"))' "$config_path")" \
  || fail "invalid secretFile in gateway config"
[ -f "$secret_file" ] && [ ! -L "$secret_file" ] || fail "missing regular SOPS payload"
sops filestatus "$secret_file" | jq -e '.encrypted == true' >/dev/null \
  || fail "client payload is not encrypted"

value="$(sops decrypt --output-type json "$secret_file" | jq -er --arg field "$field" '.[$field]')" \
  || fail "missing $field in client payload"
case "$field" in
  CURSOR_API_KEY)
    [[ "$value" =~ ^crsr_[A-Za-z0-9_-]{64}$ ]] || fail "invalid Cursor key format"
    ;;
  CLIPROXYAPI_CLIENT_API_KEY)
    [[ "$value" =~ ^[A-Za-z0-9_-]{32,}$ ]] || fail "invalid gateway key format"
    ;;
esac
printf '%s\n' "$value"
