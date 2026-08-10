#!/usr/bin/env bash

dotfiles_homebrew_path_uid() {
  local target="$1"

  case "$(uname -s)" in
    Darwin) stat -f '%u' "$target" ;;
    *) stat -c '%u' "$target" ;;
  esac
}

dotfiles_homebrew_require_prefix_owner() {
  local prefix
  local owner_uid
  local current_uid
  local owner_name
  local current_name

  prefix="$(brew --prefix)" || return 1
  [ -d "$prefix" ] || {
    printf 'Homebrew prefix does not exist: %s\n' "$prefix" >&2
    return 1
  }

  owner_uid="$(dotfiles_homebrew_path_uid "$prefix")" || return 1
  current_uid="$(id -u)"
  if [ "$current_uid" = "$owner_uid" ]; then
    return 0
  fi

  owner_name="$(id -un "$owner_uid" 2>/dev/null || printf 'uid %s' "$owner_uid")"
  current_name="$(id -un)"
  printf 'Homebrew mutations must run as prefix owner %s; current user is %s\n' "$owner_name" "$current_name" >&2
  return 1
}

dotfiles_homebrew_repair_shared_readability() {
  local prefix
  local current_uid

  dotfiles_homebrew_require_prefix_owner || return 1
  prefix="$(brew --prefix)" || return 1
  current_uid="$(id -u)"

  find "$prefix" -xdev -type d -user "$current_uid" ! -perm -0050 \
    -exec chmod g+rX {} + || return 1
  find "$prefix" -xdev -type f -user "$current_uid" ! -perm -0040 \
    -exec chmod g+r {} + || return 1
  find "$prefix" -xdev -type f -user "$current_uid" -perm -0100 ! -perm -0010 \
    -exec chmod g+x {} + || return 1

  if [ "$(uname -s)" = Darwin ]; then
    find "$prefix" -xdev -type l -user "$current_uid" ! -perm -0050 \
      -exec chmod -h g+rX {} + || return 1
  fi
}

dotfiles_homebrew_bundle_check() {
  local file="$1"
  local profile="$2"

  HOMEBREW_BUNDLE_DOTFILES_PROFILE="$profile" HOMEBREW_NO_AUTO_UPDATE=1 \
    brew bundle check --file "$file"
}

dotfiles_homebrew_fail_external() {
  printf 'invalid external Homebrew capability: %s\n' "$1" >&2
  return 1
}

dotfiles_homebrew_external_file_mode() {
  case "$(uname -s)" in
    Darwin) stat -f '%Lp' "$1" ;;
    *) stat -c '%a' "$1" ;;
  esac
}

dotfiles_homebrew_validate_external_file() {
  local config_file="$1"
  local mode

  if [ ! -f "$config_file" ] || [ -L "$config_file" ] || [ ! -r "$config_file" ]; then
    dotfiles_homebrew_fail_external "$config_file must be a readable regular file"
    return 1
  fi
  if [ "$(dotfiles_homebrew_path_uid "$config_file")" != "$(id -u)" ]; then
    dotfiles_homebrew_fail_external "$config_file must be owned by the current user"
    return 1
  fi
  if ! mode="$(dotfiles_homebrew_external_file_mode "$config_file")"; then
    dotfiles_homebrew_fail_external "cannot read permissions for $config_file"
    return 1
  fi
  case "$mode" in
    *[2367][0-7]|*[0-7][2367])
      dotfiles_homebrew_fail_external "$config_file must not be group or world writable"
      return 1
      ;;
  esac
}

dotfiles_homebrew_external_entry_declared() {
  local repo_root="$1"
  local profile="$2"
  local package_type="$3"
  local package_name="$4"
  local list_flag
  local file

  case "$package_type" in
    brew) list_flag="--formula" ;;
    cask) list_flag="--cask" ;;
    *) return 1 ;;
  esac

  while IFS= read -r file; do
    if HOMEBREW_BUNDLE_DOTFILES_PROFILE="$profile" HOMEBREW_NO_AUTO_UPDATE=1 \
      brew bundle list "$list_flag" --file "$repo_root/$file" 2>/dev/null \
      | grep -Fqx "$package_name"; then
      return 0
    fi
  done < <(dotfiles_profile_brewfiles "$profile")
  return 1
}

dotfiles_homebrew_validate_external_command() {
  local package_type="$1"
  local package_name="$2"
  local target="$3"
  local owner_uid
  local mode
  shift 3

  case "$target" in
    /*) ;;
    *)
      dotfiles_homebrew_fail_external "$package_type $package_name command path must be absolute"
      return 1
      ;;
  esac
  if [ ! -x "$target" ]; then
    dotfiles_homebrew_fail_external "$package_type $package_name command is not executable: $target"
    return 1
  fi
  owner_uid="$(dotfiles_homebrew_path_uid "$target")" || {
    dotfiles_homebrew_fail_external "cannot read ownership for $target"
    return 1
  }
  if [ "$owner_uid" != "$(id -u)" ] && [ "$owner_uid" != 0 ]; then
    dotfiles_homebrew_fail_external "$target must be owned by the current user or root"
    return 1
  fi
  mode="$(dotfiles_homebrew_external_file_mode "$target")" || {
    dotfiles_homebrew_fail_external "cannot read permissions for $target"
    return 1
  }
  case "$mode" in
    *[2367][0-7]|*[0-7][2367])
      dotfiles_homebrew_fail_external "$target must not be group or world writable"
      return 1
      ;;
  esac
  if ! "$target" "$@"; then
    dotfiles_homebrew_fail_external "$package_type $package_name command check failed: $target"
    return 1
  fi
}

dotfiles_homebrew_codesign() {
  /usr/bin/codesign "$@"
}

dotfiles_homebrew_validate_external_bundle() {
  local package_type="$1"
  local package_name="$2"
  local target="$3"
  local expected_bundle_id="$4"
  local expected_team_id="$5"
  local actual_bundle_id
  local actual_team_id

  if [ "$package_type" != cask ]; then
    dotfiles_homebrew_fail_external "$package_name bundle validation requires a cask"
    return 1
  fi
  if [ -z "$expected_team_id" ] || [ "$expected_team_id" = "not set" ]; then
    dotfiles_homebrew_fail_external "$package_name requires a concrete signing team"
    return 1
  fi
  case "$target" in
    /*.app) ;;
    *)
      dotfiles_homebrew_fail_external "$package_name bundle path must be an absolute .app path"
      return 1
      ;;
  esac
  if [ ! -d "$target" ] || [ -L "$target" ]; then
    dotfiles_homebrew_fail_external "$package_name bundle is missing or symlinked: $target"
    return 1
  fi
  if ! actual_bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$target/Contents/Info.plist" 2>/dev/null)"; then
    dotfiles_homebrew_fail_external "$package_name bundle identifier is unreadable"
    return 1
  fi
  if [ "$actual_bundle_id" != "$expected_bundle_id" ]; then
    dotfiles_homebrew_fail_external "$package_name bundle identifier is $actual_bundle_id; expected $expected_bundle_id"
    return 1
  fi
  if ! dotfiles_homebrew_codesign --verify --deep --strict "$target"; then
    dotfiles_homebrew_fail_external "$package_name bundle signature verification failed"
    return 1
  fi
  if ! actual_team_id="$(dotfiles_homebrew_codesign -dv --verbose=4 "$target" 2>&1 | awk -F= '$1 == "TeamIdentifier" { print $2; exit }')"; then
    dotfiles_homebrew_fail_external "$package_name signing team is unreadable"
    return 1
  fi
  if [ -z "$actual_team_id" ] || [ "$actual_team_id" != "$expected_team_id" ]; then
    dotfiles_homebrew_fail_external "$package_name signing team is ${actual_team_id:-missing}; expected $expected_team_id"
    return 1
  fi
}

dotfiles_homebrew_append_skip() {
  local package_type="$1"
  local package_name="$2"

  case "$package_type" in
    brew)
      HOMEBREW_BUNDLE_BREW_SKIP="${HOMEBREW_BUNDLE_BREW_SKIP:+$HOMEBREW_BUNDLE_BREW_SKIP }$package_name"
      export HOMEBREW_BUNDLE_BREW_SKIP
      ;;
    cask)
      HOMEBREW_BUNDLE_CASK_SKIP="${HOMEBREW_BUNDLE_CASK_SKIP:+$HOMEBREW_BUNDLE_CASK_SKIP }$package_name"
      export HOMEBREW_BUNDLE_CASK_SKIP
      ;;
  esac
}

dotfiles_homebrew_plist_extract() {
  local config_file="$1"
  local key_path="$2"
  local expected_type="$3"
  local value

  if ! value="$(/usr/bin/plutil -extract "$key_path" raw -expect "$expected_type" "$config_file" 2>/dev/null)"; then
    dotfiles_homebrew_fail_external "$key_path must be $expected_type in $config_file"
    return 1
  fi
  printf '%s\n' "$value"
}

dotfiles_homebrew_configure_external_capabilities() {
  local repo_root="$1"
  local profile="$2"
  local default_file="$HOME/.config/dotfiles/external-homebrew.plist"
  local config_file="${DOTFILES_EXTERNAL_HOMEBREW_FILE:-$default_file}"
  local first_line
  local version
  local capability_count
  local index
  local key_path
  local package_type
  local package_name
  local validator
  local target
  local bundle_identifier
  local team_identifier
  local argument_count
  local argument_index
  local argument
  local seen=""
  local key
  local -a validator_args

  if [ -n "${HOMEBREW_BUNDLE_BREW_SKIP:-}" ] ||
    [ -n "${HOMEBREW_BUNDLE_CASK_SKIP:-}" ] ||
    [ -n "${HOMEBREW_BUNDLE_TAP_SKIP:-}" ] ||
    [ -n "${HOMEBREW_BUNDLE_MAS_SKIP:-}" ]; then
    dotfiles_homebrew_fail_external "ambient Homebrew Bundle skip variables are unsupported; use $config_file"
    return 1
  fi
  if [ ! -e "$config_file" ] && [ ! -L "$config_file" ]; then
    return 0
  fi
  dotfiles_homebrew_validate_external_file "$config_file" || return 1
  if ! /usr/bin/plutil -lint "$config_file" >/dev/null; then
    dotfiles_homebrew_fail_external "$config_file is not a valid property list"
    return 1
  fi
  if ! IFS= read -r first_line <"$config_file" || [[ "$first_line" != '<?xml '* ]]; then
    dotfiles_homebrew_fail_external "$config_file must be an XML property list"
    return 1
  fi

  version="$(dotfiles_homebrew_plist_extract "$config_file" version integer)" || return 1
  if [ "$version" != 1 ]; then
    dotfiles_homebrew_fail_external "unsupported version $version in $config_file; expected 1"
    return 1
  fi
  capability_count="$(dotfiles_homebrew_plist_extract "$config_file" capabilities array)" || return 1

  for ((index = 0; index < capability_count; index += 1)); do
    key_path="capabilities.$index"
    dotfiles_homebrew_plist_extract "$config_file" "$key_path" dictionary >/dev/null || return 1
    package_type="$(dotfiles_homebrew_plist_extract "$config_file" "$key_path.packageType" string)" || return 1
    package_name="$(dotfiles_homebrew_plist_extract "$config_file" "$key_path.name" string)" || return 1
    validator="$(dotfiles_homebrew_plist_extract "$config_file" "$key_path.validator" string)" || return 1
    target="$(dotfiles_homebrew_plist_extract "$config_file" "$key_path.path" string)" || return 1

    case "$package_type" in
      brew|cask) ;;
      *)
        dotfiles_homebrew_fail_external "unsupported package type $package_type at $key_path"
        return 1
        ;;
    esac
    case "$package_name" in
      ""|*[!A-Za-z0-9@+._/-]*)
        dotfiles_homebrew_fail_external "unsupported package name $package_name at $key_path"
        return 1
        ;;
    esac
    if ! dotfiles_homebrew_external_entry_declared "$repo_root" "$profile" "$package_type" "$package_name"; then
      dotfiles_homebrew_fail_external "$package_type $package_name is not declared by profile $profile"
      return 1
    fi
    key="$package_type|$package_name"
    if printf '%s\n' "$seen" | grep -Fqx "$key"; then
      dotfiles_homebrew_fail_external "duplicate $key"
      return 1
    fi
    if [ -n "$seen" ]; then
      seen+=$'\n'
    fi
    seen+="$key"

    validator_args=()
    case "$validator" in
      command)
        argument_count="$(dotfiles_homebrew_plist_extract "$config_file" "$key_path.arguments" array)" || return 1
        if [ "$argument_count" -gt 3 ]; then
          dotfiles_homebrew_fail_external "$package_name command validation accepts at most three arguments"
          return 1
        fi
        for ((argument_index = 0; argument_index < argument_count; argument_index += 1)); do
          argument="$(dotfiles_homebrew_plist_extract "$config_file" "$key_path.arguments.$argument_index" string)" || return 1
          validator_args+=("$argument")
        done
        dotfiles_homebrew_validate_external_command "$package_type" "$package_name" "$target" ${validator_args[@]+"${validator_args[@]}"} || return 1
        ;;
      bundle)
        bundle_identifier="$(dotfiles_homebrew_plist_extract "$config_file" "$key_path.bundleIdentifier" string)" || return 1
        team_identifier="$(dotfiles_homebrew_plist_extract "$config_file" "$key_path.teamIdentifier" string)" || return 1
        dotfiles_homebrew_validate_external_bundle "$package_type" "$package_name" "$target" "$bundle_identifier" "$team_identifier" || return 1
        ;;
      *)
        dotfiles_homebrew_fail_external "$package_name uses unsupported validator $validator"
        return 1
        ;;
    esac
    dotfiles_homebrew_append_skip "$package_type" "$package_name"
    printf 'validated external %s %s\n' "$package_type" "$package_name"
  done
}
