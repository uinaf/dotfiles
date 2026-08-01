#!/usr/bin/env bash

dotfiles_resolve_launchd_namespace() {
  local namespace="${1:-${DOTFILES_LAUNCHD_NAMESPACE:-local.dotfiles}}"

  case "$namespace" in
    ""|.*|*.|*..*|*[!A-Za-z0-9.-]*)
      return 2
      ;;
  esac

  printf '%s\n' "$namespace"
}

dotfiles_launchd_label() {
  local service="$1"
  local user="$2"
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
