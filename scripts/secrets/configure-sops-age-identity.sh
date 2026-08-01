#!/usr/bin/env bash
set -euo pipefail

mode="provision"

usage() {
  cat <<'USAGE'
Usage:
  scripts/secrets/configure-sops-age-identity.sh
  scripts/secrets/configure-sops-age-identity.sh --check
  scripts/secrets/configure-sops-age-identity.sh --print-recipient

Creates or verifies the current Unix user's private age identity at the path
SOPS uses by default. The private identity stays owner-only and must be backed
up through an approved human recovery system before it protects live secrets.

Set SOPS_AGE_KEY_FILE to use an explicit owner-only identity path.
USAGE
}

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

identity_path() {
  if [ -n "${SOPS_AGE_KEY_FILE:-}" ]; then
    printf '%s\n' "$SOPS_AGE_KEY_FILE"
  elif [ -n "${XDG_CONFIG_HOME:-}" ]; then
    printf '%s/sops/age/keys.txt\n' "$XDG_CONFIG_HOME"
  elif [ "$(uname -s)" = Darwin ]; then
    printf '%s/Library/Application Support/sops/age/keys.txt\n' "$HOME"
  else
    printf '%s/.config/sops/age/keys.txt\n' "$HOME"
  fi
}

path_mode() {
  if [ "$(uname -s)" = Darwin ]; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

path_uid() {
  if [ "$(uname -s)" = Darwin ]; then
    stat -f '%u' "$1"
  else
    stat -c '%u' "$1"
  fi
}

validate_identity() {
  local identity_file="$1"
  local identity_dir
  local recipient

  identity_dir="$(dirname "$identity_file")"
  [ -d "$identity_dir" ] || fail "missing identity directory: $identity_dir"
  [ ! -L "$identity_dir" ] || fail "identity directory must not be a symlink: $identity_dir"
  [ -f "$identity_file" ] || fail "missing age identity: $identity_file"
  [ ! -L "$identity_file" ] || fail "age identity must not be a symlink: $identity_file"
  [ "$(path_uid "$identity_dir")" = "$(id -u)" ] \
    || fail "identity directory is not owned by the current user: $identity_dir"
  [ "$(path_uid "$identity_file")" = "$(id -u)" ] \
    || fail "age identity is not owned by the current user: $identity_file"
  [ "$(path_mode "$identity_dir")" = 700 ] \
    || fail "identity directory must have mode 0700: $identity_dir"
  [ "$(path_mode "$identity_file")" = 600 ] \
    || fail "age identity must have mode 0600: $identity_file"

  recipient="$(age-keygen -y "$identity_file" 2>/dev/null)" \
    || fail "age-keygen could not derive a recipient from $identity_file"
  case "$recipient" in
    age1*) ;;
    *) fail "age-keygen returned an invalid public recipient" ;;
  esac

  printf '%s\n' "$recipient"
}

verify_sops_round_trip() {
  local identity_file="$1"
  local recipient="$2"
  local tmp_dir
  local plaintext_file
  local encrypted_file
  local expected='DOTFILES_SOPS_PROBE=ok'
  local actual

  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-sops-age.XXXXXX")"
  plaintext_file="$tmp_dir/probe.env"
  encrypted_file="$tmp_dir/probe.sops.env"
  trap 'rm -rf -- "$tmp_dir"' EXIT HUP INT TERM
  umask 077
  printf '%s\n' "$expected" > "$plaintext_file"
  (
    cd "$tmp_dir"
    sops encrypt \
      --age "$recipient" \
      --input-type dotenv \
      --output-type dotenv \
      "$plaintext_file" > "$encrypted_file"
  ) || fail "SOPS could not encrypt to the generated recipient"
  actual="$(
    env \
      -u SOPS_AGE_KEY \
      -u SOPS_AGE_KEY_CMD \
      -u SOPS_AGE_SSH_PRIVATE_KEY_CMD \
      -u SOPS_AGE_SSH_PRIVATE_KEY_FILE \
      SOPS_AGE_KEY_FILE="$identity_file" \
      sops decrypt \
        --input-type dotenv \
        --output-type dotenv \
        "$encrypted_file"
  )" || fail "SOPS could not decrypt with $identity_file"
  [ "$actual" = "$expected" ] || fail "SOPS age identity round trip changed the probe payload"
  rm -rf -- "$tmp_dir"
  trap - EXIT HUP INT TERM
}

validate_sops_version() {
  local version
  local major
  local remainder
  local minor

  version="$(sops --version 2>/dev/null | awk 'NR == 1 { print $2 }')" \
    || fail "could not determine the SOPS version"
  case "$version" in
    [0-9]*.[0-9]*.*) ;;
    *) fail "could not parse the SOPS version: $version" ;;
  esac

  major="${version%%.*}"
  remainder="${version#*.}"
  minor="${remainder%%.*}"
  if [ "$major" -lt 3 ] || { [ "$major" -eq 3 ] && [ "$minor" -lt 9 ]; }; then
    fail "SOPS 3.9.0 or newer is required; found $version"
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check)
      [ "$mode" = provision ] || {
        usage >&2
        exit 2
      }
      mode="check"
      ;;
    --print-recipient)
      [ "$mode" = provision ] || {
        usage >&2
        exit 2
      }
      mode="print-recipient"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  shift
done

command -v age-keygen >/dev/null 2>&1 || fail "missing age-keygen"
identity_file="$(identity_path)"
identity_dir="$(dirname "$identity_file")"

if [ "$mode" = provision ]; then
  if [ -e "$identity_dir" ] || [ -L "$identity_dir" ]; then
    [ -d "$identity_dir" ] && [ ! -L "$identity_dir" ] \
      || fail "refusing to use non-directory identity path: $identity_dir"
    [ "$(path_uid "$identity_dir")" = "$(id -u)" ] \
      || fail "refusing to change identity directory owned by another user: $identity_dir"
  else
    umask 077
    mkdir -p "$identity_dir"
  fi

  if [ -e "$identity_file" ] || [ -L "$identity_file" ]; then
    [ -f "$identity_file" ] && [ ! -L "$identity_file" ] \
      || fail "refusing to replace non-regular age identity path: $identity_file"
  else
    staging_dir="$(mktemp -d "$identity_dir/.age-identity.XXXXXX")" \
      || fail "could not create an identity staging directory"
    staged_file="$staging_dir/keys.txt"
    umask 077
    if ! age-keygen -o "$staged_file" >/dev/null 2>&1; then
      rm -f -- "$staged_file"
      rmdir "$staging_dir"
      fail "age-keygen could not create $identity_file"
    fi
    chmod 0600 "$staged_file"
    mv -- "$staged_file" "$identity_file"
    rmdir "$staging_dir"
  fi
  chmod 0700 "$identity_dir"
  chmod 0600 "$identity_file"
fi

recipient="$(validate_identity "$identity_file")"

if [ "$mode" = print-recipient ]; then
  printf '%s\n' "$recipient"
  exit 0
fi

command -v sops >/dev/null 2>&1 || fail "missing sops"
validate_sops_version
verify_sops_round_trip "$identity_file" "$recipient"

printf 'SOPS age identity ready: %s\n' "$identity_file"
printf 'public recipient: %s\n' "$recipient"
if [ "$mode" = provision ]; then
  printf 'backup required: save the private identity in the approved human recovery system before use\n'
else
  printf 'ok owner, permissions, recipient, and SOPS round trip\n'
fi
