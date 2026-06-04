#!/usr/bin/env bash

INFISICAL_LOGIN_STATUS_JSON=""
INFISICAL_LOGIN_STATUS_EXIT=0

infisical_capture_login_status() {
  local domain="$1"

  set +e
  INFISICAL_LOGIN_STATUS_JSON="$(infisical login status --domain "$domain" --json 2>/dev/null)"
  # shellcheck disable=SC2034
  INFISICAL_LOGIN_STATUS_EXIT=$?
  set -e
}

infisical_status_has_sessions() {
  printf '%s\n' "$INFISICAL_LOGIN_STATUS_JSON" | grep -q '"sessions"'
}

infisical_status_has_authenticated_human_user() {
  printf '%s\n' "$INFISICAL_LOGIN_STATUS_JSON" \
    | tr -d '\n' \
    | grep -Eq '"principalType"[[:space:]]*:[[:space:]]*"user"[^}]*"status"[[:space:]]*:[[:space:]]*"authenticated"|"status"[[:space:]]*:[[:space:]]*"authenticated"[^}]*"principalType"[[:space:]]*:[[:space:]]*"user"'
}

infisical_status_has_only_inactive_sessions() {
  local statuses

  statuses="$(
    printf '%s\n' "$INFISICAL_LOGIN_STATUS_JSON" \
      | grep -Eo '"status"[[:space:]]*:[[:space:]]*"[^"]+"' \
      | grep -Ev '"(expired|unauthenticated)"' || true
  )"

  [ -z "$statuses" ]
}

infisical_mint_machine_token() {
  local domain="$1"
  local client_id="$2"
  local client_secret="$3"

  infisical login \
    --domain "$domain" \
    --method=universal-auth \
    --client-id "$client_id" \
    --client-secret "$client_secret" \
    --plain \
    --silent
}
