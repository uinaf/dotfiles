#!/usr/bin/env bash
set -euo pipefail

# Codex launcher that injects the Gatewai provider as CLI overrides, so
# harnesses that pass --ignore-user-config (for example openclaw autoreview)
# still authenticate through the gateway credential helper. No secrets enter
# the environment or the argument list.

# Harnesses may redirect HOME for the launched process, so resolve every path
# from this script's installed location (<home>/.local/libexec/dotfiles).
script_dir="$(cd "$(dirname "$0")" && pwd)"
install_home="${script_dir%/.local/libexec/dotfiles}"
config_path="${LLM_GATEWAY_CONFIG:-$install_home/.config/dotfiles/llm-gateway.json}"
credential="$script_dir/llm-gateway-credential"

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || fail "missing jq"
[ -x "$credential" ] || fail "missing llm-gateway-credential helper"
[ -f "$config_path" ] && [ ! -L "$config_path" ] || fail "missing regular gateway config"
config_mode="$(stat -f '%Lp' "$config_path" 2>/dev/null || stat -c '%a' "$config_path" 2>/dev/null)" \
  || fail "could not inspect gateway config permissions"
[ "$config_mode" = 600 ] || fail "gateway config mode must be 0600"

base_url="$(jq -er '.gatewaiBaseUrl | select(type == "string")' "$config_path")" \
  || fail "missing gatewaiBaseUrl in gateway config"
case "$base_url" in
  https://*/v1) ;;
  *) fail "gatewaiBaseUrl must be an HTTPS /v1 URL" ;;
esac

# The auth command runs as a child of codex and would inherit any redirected
# HOME; pin the resolved config path for it explicitly.
export LLM_GATEWAY_CONFIG="$config_path"

overrides=(
  'model_provider="gatewai"'
  'model_providers.gatewai.name="Gatewai"'
  "model_providers.gatewai.base_url=\"$base_url\""
  'model_providers.gatewai.wire_api="responses"'
  'model_providers.gatewai.requires_openai_auth=false'
  'model_providers.gatewai.supports_websockets=false'
  "model_providers.gatewai.auth.command=\"$credential\""
  'model_providers.gatewai.auth.args=["gatewai"]'
  'model_providers.gatewai.auth.timeout_ms=5000'
  'model_providers.gatewai.auth.refresh_interval_ms=0'
)

# configure-llm-gateway --check compares this against the Codex config edits
# so the launcher cannot drift from the enrolled provider definition.
if [ "${1:-}" = "--gateway-overrides" ]; then
  printf '%s\n' "${overrides[@]}"
  exit 0
fi

arguments=()
for override in "${overrides[@]}"; do
  arguments+=(-c "$override")
done
exec codex "${arguments[@]}" "$@"
