#!/usr/bin/env bash

: "${json_output:=0}"
: "${warn_count:=0}"
: "${fail_count:=0}"
: "${secret_scan_count:=0}"

section() {
  [ "$json_output" -eq 1 ] && return
  printf '\n## %s\n' "$1"
}

ok() {
  [ "$json_output" -eq 1 ] && return
  printf 'ok %s\n' "$1"
}

warn() {
  warn_count=$((warn_count + 1))
  [ "$json_output" -eq 1 ] && return
  printf 'warn %s\n' "$1" >&2
}

fail_check() {
  fail_count=$((fail_count + 1))
  [ "$json_output" -eq 1 ] && return
  printf 'FAILED: %s\n' "$1" >&2
}

json_string() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

mode_of() {
  stat -f '%Lp' "$1"
}

owner_of() {
  stat -f '%Su' "$1"
}

check_mode_any() {
  local missing_severity="$1"
  local path="$2"
  shift 2
  local mode
  local expected

  if [ ! -e "$path" ]; then
    if [ "$missing_severity" = "fail" ]; then
      fail_check "missing $path"
    else
      warn "missing $path"
    fi
    return
  fi

  mode="$(mode_of "$path")"
  for expected in "$@"; do
    if [ "$mode" = "$expected" ]; then
      ok "$path mode $mode"
      return
    fi
  done

  fail_check "$path mode is $mode, expected one of: $*"
}

check_pattern_absent() {
  local path="$1"
  local pattern="$2"
  local label="$3"
  local severity="$4"

  if [ ! -e "$path" ]; then
    return
  fi

  if [ ! -r "$path" ]; then
    warn "cannot read $path for $label"
    return
  fi

  if grep -Eq "$pattern" "$path"; then
    if [ "$severity" = "fail" ]; then
      fail_check "$path contains $label"
    else
      warn "$path contains $label"
    fi
  else
    ok "$path does not contain $label"
  fi
}

scan_file_for_secret_pattern() {
  local path="$1"
  local pattern="$2"
  local label="$3"

  if [ ! -r "$path" ]; then
    warn "cannot read $path for $label"
    return
  fi

  secret_scan_count=$((secret_scan_count + 1))
  if grep -Eq "$pattern" "$path"; then
    fail_check "$path contains $label"
  fi
}

scan_files_for_secrets() {
  local scan_root
  local path
  local rel_path
  local link_path
  local linked_count=0
  local trufflehog_status

  if ! command -v gitleaks >/dev/null 2>&1; then
    fail_check "gitleaks is missing for local secret scan"
    return
  fi

  if ! command -v trufflehog >/dev/null 2>&1; then
    fail_check "trufflehog is missing for local secret scan"
    return
  fi

  scan_root="$(mktemp -d "${TMPDIR:-/tmp}/uinaf-secret-scan.XXXXXX")"
  chmod 700 "$scan_root"

  while IFS= read -r path; do
    [ -n "$path" ] || continue

    if [ ! -r "$path" ]; then
      warn "cannot read $path for gitleaks secret scan"
      continue
    fi

    secret_scan_count=$((secret_scan_count + 1))

    case "$path" in
      "$HOME"/*) rel_path="home/${path#"$HOME"/}" ;;
      /*) rel_path="root/${path#/}" ;;
      *) rel_path="relative/$path" ;;
    esac

    link_path="$scan_root/$rel_path"
    mkdir -p "$(dirname "$link_path")"
    ln -s "$path" "$link_path"
    linked_count=$((linked_count + 1))
  done

  if [ "$linked_count" -eq 0 ]; then
    warn "no readable local config files found for gitleaks secret scan"
    rm -rf "$scan_root"
    return
  fi

  if [ "$json_output" -eq 1 ]; then
    if gitleaks dir --follow-symlinks --redact --no-banner --log-level error "$scan_root" >/dev/null 2>&1; then
      ok "gitleaks found no leaks in $linked_count local config files"
    else
      fail_check "gitleaks reported possible leaks in local config files"
    fi
  elif gitleaks dir --follow-symlinks --redact --no-banner "$scan_root"; then
    ok "gitleaks found no leaks in $linked_count local config files"
  else
    fail_check "gitleaks reported possible leaks in local config files"
  fi

  trufflehog_status=0
  if [ "$json_output" -eq 1 ]; then
    trufflehog filesystem \
      --no-update \
      --no-color \
      --results=verified \
      --fail \
      --force-skip-binaries \
      --force-skip-archives \
      --max-symlink-depth=1 \
      "$scan_root" >/dev/null 2>&1 || trufflehog_status=$?
  else
    trufflehog filesystem \
      --no-update \
      --no-color \
      --results=verified \
      --fail \
      --force-skip-binaries \
      --force-skip-archives \
      --max-symlink-depth=1 \
      "$scan_root" || trufflehog_status=$?
  fi

  if [ "$trufflehog_status" -eq 0 ]; then
    ok "trufflehog found no verified leaks in $linked_count local config files"
  elif [ "$trufflehog_status" -eq 183 ]; then
    fail_check "trufflehog reported verified leaks in local config files"
  else
    fail_check "trufflehog local config scan failed"
  fi

  rm -rf "$scan_root"
}

scan_files_with_gitleaks() {
  scan_files_for_secrets "$@"
}

find_matching_files() {
  local base="$1"
  shift

  if [ -d "$base" ]; then
    find "$base" "$@" -print 2>/dev/null || true
  fi
}

warn_on_broad_gh_scopes() {
  local status_output
  local scopes_line
  local scope

  command -v gh >/dev/null 2>&1 || return

  status_output="$(gh auth status -h github.com 2>&1 || true)"
  scopes_line="$(printf '%s\n' "$status_output" | sed -nE "s/.*Token scopes: (.*)/\1/p" | tail -n 1)"
  [ -n "$scopes_line" ] || return

  for scope in delete_repo workflow admin:org admin:public_key admin:repo_hook write:packages; do
    case "$scopes_line" in
      *"$scope"*)
        warn "gh token has broad scope: $scope"
        ;;
    esac
  done
}

emit_path_if_exists() {
  local path="$1"

  if [ -e "$path" ]; then
    printf '%s\n' "$path"
  fi
}

emit_home_dotfiles() {
  find_matching_files "$HOME" -maxdepth 1 -type f -name '.*' \
    ! -name '.CFUserTextEncoding' \
    ! -name '.DS_Store' \
    ! -name '.localized'
}
