#!/usr/bin/env bash

DOTFILES_PROFILE_MODEL_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/chezmoi/.chezmoidata/profiles.json"
DOTFILES_PLUTIL="/usr/bin/plutil"
_DOTFILES_VALIDATED_PROFILE_MODEL=""

dotfiles_profile_model_validate() {
  local version

  if [ "$_DOTFILES_VALIDATED_PROFILE_MODEL" = "$DOTFILES_PROFILE_MODEL_FILE" ]; then
    return 0
  fi
  [ -f "$DOTFILES_PROFILE_MODEL_FILE" ] && [ ! -L "$DOTFILES_PROFILE_MODEL_FILE" ] \
    && [ -x "$DOTFILES_PLUTIL" ] || return 2
  version="$($DOTFILES_PLUTIL -extract profileModel.version raw -expect integer "$DOTFILES_PROFILE_MODEL_FILE" 2>/dev/null)" \
    || return 2
  [ "$version" = 1 ] || return 2
  "$DOTFILES_PLUTIL" -extract profileModel.profiles raw -expect dictionary \
    "$DOTFILES_PROFILE_MODEL_FILE" >/dev/null 2>&1 || return 2
  _DOTFILES_VALIDATED_PROFILE_MODEL="$DOTFILES_PROFILE_MODEL_FILE"
}

dotfiles_profile_extract() {
  local profile="$1"
  local key="$2"
  local type="$3"

  dotfiles_profile_model_validate || return 2
  dotfiles_normalize_profile "$profile" >/dev/null || return 2
  "$DOTFILES_PLUTIL" -extract "profileModel.profiles.$profile.$key" raw -expect "$type" \
    "$DOTFILES_PROFILE_MODEL_FILE" 2>/dev/null || return 2
}

dotfiles_profiles() {
  dotfiles_profile_model_validate || return 2
  "$DOTFILES_PLUTIL" -extract profileModel.profiles raw -expect dictionary \
    "$DOTFILES_PROFILE_MODEL_FILE" 2>/dev/null || return 2
}

dotfiles_normalize_profile() {
  local requested="${1:-}"

  case "$requested" in
    ""|*[!a-z-]*) return 2 ;;
  esac
  dotfiles_profile_model_validate || return 2
  "$DOTFILES_PLUTIL" -extract "profileModel.profiles.$requested" raw -expect dictionary \
    "$DOTFILES_PROFILE_MODEL_FILE" >/dev/null 2>&1 || return 2
  printf '%s\n' "$requested"
}

dotfiles_trim_profile() {
  local value="${1:-}"

  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s\n' "$value"
}

dotfiles_read_persisted_profile() {
  local profile_file="$1"
  local expected_uid="${2:-}"
  local profile_mode=""
  local profile_uid=""
  local value=""

  [ -f "$profile_file" ] && [ ! -L "$profile_file" ] && [ -r "$profile_file" ] \
    || return 3
  if [ "$(uname -s)" = Darwin ]; then
    profile_mode="$(stat -f '%Lp' "$profile_file")" || return 3
    profile_uid="$(stat -f '%u' "$profile_file")" || return 3
  else
    profile_mode="$(stat -c '%a' "$profile_file" 2>/dev/null)" || return 3
    profile_uid="$(stat -c '%u' "$profile_file")" || return 3
  fi
  case "$profile_mode" in
    [0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]) ;;
    *) return 3 ;;
  esac
  case "$profile_mode" in
    *[2367][0-7]|*[0-7][2367]) return 3 ;;
  esac
  if [ -n "$expected_uid" ] && [ "$profile_uid" != "$expected_uid" ]; then
    return 3
  fi
  awk 'END { exit NR == 1 ? 0 : 1 }' "$profile_file" || return 3
  IFS= read -r value < "$profile_file" || [ -n "$value" ] || return 3
  value="$(dotfiles_trim_profile "$value")"
  dotfiles_normalize_profile "$value" >/dev/null || return 3
  dotfiles_normalize_profile "$value"
}

dotfiles_resolve_profile() {
  local requested="${1:-}"
  local profile_file="${DOTFILES_PROFILE_FILE:-$HOME/.config/dotfiles/profile}"
  local explicit_profile_file=0

  if [ -n "${DOTFILES_PROFILE_FILE:-}" ]; then
    explicit_profile_file=1
  fi

  if [ -z "$requested" ]; then
    if [ -e "$profile_file" ] || [ -L "$profile_file" ]; then
      requested="$(dotfiles_read_persisted_profile "$profile_file" "$(id -u)")" || return 3
    elif [ "$explicit_profile_file" -eq 1 ]; then
      return 3
    else
      requested="${DOTFILES_PROFILE:-}"
    fi
  fi

  requested="$(dotfiles_trim_profile "$requested")"
  [ -n "$requested" ] || return 1
  dotfiles_normalize_profile "$requested"
}

dotfiles_profile_has_capability() {
  local value

  value="$(dotfiles_profile_extract "$1" "capabilities.$2" bool)" || return 2
  [ "$value" = true ]
}

dotfiles_profile_is_developer() {
  dotfiles_profile_has_capability "$1" developer
}

dotfiles_profile_is_workload() {
  dotfiles_profile_has_capability "$1" workload
}

dotfiles_profile_uses_shared_brew() {
  dotfiles_profile_has_capability "$1" sharedHomebrew
}

dotfiles_profile_requires_sops_identity() {
  dotfiles_profile_has_capability "$1" requiresSopsIdentity
}

dotfiles_profile_is_devbox() {
  dotfiles_profile_has_capability "$1" devbox
}

dotfiles_profile_is_workstation() {
  dotfiles_profile_has_capability "$1" workstation
}

dotfiles_profile_is_personal() {
  dotfiles_profile_has_capability "$1" personal
}

dotfiles_profile_array() {
  local profile="$1"
  local field="$2"
  local count
  local index=0

  count="$(dotfiles_profile_extract "$profile" "$field" array)" || return 2
  while [ "$index" -lt "$count" ]; do
    dotfiles_profile_extract "$profile" "$field.$index" string || return 2
    index=$((index + 1))
  done
}

dotfiles_profile_brewfiles() {
  dotfiles_profile_array "$1" brewfiles
}

dotfiles_profile_install_steps() {
  dotfiles_profile_array "$1" installSteps
}

dotfiles_profile_skill_layers() {
  dotfiles_profile_array "$1" skillLayers
}

dotfiles_profile_runtime_group() {
  dotfiles_profile_extract "$1" runtimeGroup string
}
