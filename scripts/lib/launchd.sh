#!/usr/bin/env bash

dotfiles_resolve_launchd_namespace() {
  local namespace="${1:-${DOTFILES_LAUNCHD_NAMESPACE:-local.dotfiles}}"

  case "$namespace" in
    ""|.*|*.|*..*|*[!A-Za-z0-9._-]*)
      return 2
      ;;
  esac

  printf '%s\n' "$namespace"
}

dotfiles_resolve_launchd_namespace_contract() {
  local requested_namespace="${1:-}"
  local namespace_file="${2:-}"
  local expected_uid="${3:-}"
  local requested_resolved=""
  local stored_namespace=""
  local namespace_mode=""
  local namespace_uid=""

  if [ -n "$requested_namespace" ]; then
    requested_resolved="$(dotfiles_resolve_launchd_namespace "$requested_namespace")" || return 2
  fi
  if [ -n "$namespace_file" ] \
    && { [ -e "$namespace_file" ] || [ -L "$namespace_file" ]; }; then
    [ -f "$namespace_file" ] && [ ! -L "$namespace_file" ] && [ -r "$namespace_file" ] \
      || return 4
    if [ "$(uname -s)" = Darwin ]; then
      namespace_mode="$(stat -f '%Lp' "$namespace_file")" || return 4
      namespace_uid="$(stat -f '%u' "$namespace_file")" || return 4
    else
      namespace_mode="$(stat -c '%a' "$namespace_file" 2>/dev/null)" || return 4
      namespace_uid="$(stat -c '%u' "$namespace_file")" || return 4
    fi
    [ "$namespace_mode" = 600 ] || return 4
    if [ -n "$expected_uid" ] && [ "$namespace_uid" != "$expected_uid" ]; then
      return 4
    fi
    awk 'END { exit NR == 1 ? 0 : 1 }' "$namespace_file" || return 4
    stored_namespace="$(sed -n '1p' "$namespace_file")"
    [ -n "$stored_namespace" ] || return 2
    stored_namespace="$(dotfiles_resolve_launchd_namespace "$stored_namespace")" || return 2
    if [ -n "$requested_resolved" ] && [ "$requested_resolved" != "$stored_namespace" ]; then
      return 3
    fi
    printf '%s\n' "$stored_namespace"
    return
  fi

  dotfiles_resolve_launchd_namespace "$requested_resolved"
}

dotfiles_launchd_label() {
  local service="${1:-}"
  local user="${2:-}"
  local requested_namespace="${3:-}"
  local namespace

  case "$service" in
    ""|*[!A-Za-z0-9._-]*)
      return 2
      ;;
  esac
  case "$user" in
    ""|*[!A-Za-z0-9._-]*)
      return 2
      ;;
  esac

  namespace="$(dotfiles_resolve_launchd_namespace "$requested_namespace")" || return
  printf '%s.%s.%s\n' "$namespace" "$service" "$user"
}

dotfiles_openclaw_restart_sudoers_rule() {
  local user="${1:-}"
  local label="${2:-}"

  case "$user" in
    ""|*[!A-Za-z0-9._-]*)
      return 2
      ;;
  esac
  case "$label" in
    ""|*[!A-Za-z0-9._-]*)
      return 2
      ;;
  esac

  printf '%s ALL=(root) NOPASSWD: /bin/launchctl kickstart -k system/%s\n' \
    "$user" "$label"
}

dotfiles_openclaw_restart_sudoers_name() {
  local user="${1:-}"
  local uid="${2:-}"
  local user_slug

  case "$user" in
    ""|*[!A-Za-z0-9._-]*)
      return 2
      ;;
  esac
  case "$uid" in
    ""|*[!0-9]*)
      return 2
      ;;
  esac

  user_slug="${user//./_}"
  printf 'dotfiles-openclaw-restart-%s-%s\n' "$user_slug" "$uid"
}
