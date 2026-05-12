#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
usage: devbox-refresh-openclaw-env.sh CONFIG

Refresh a devbox user's generated OpenClaw env from a narrowly scoped
1Password service account token. The config file is local machine state and
must not be committed.

Required config keys:
  IDENTITY            short stable identity name
  TARGET_USER         macOS user that will read the generated env
  OP_ACCOUNT          1Password account URL
  OP_VAULT            1Password vault name
  OP_ITEM             1Password item title or ID, usually OPENCLAW_ENV
  TOKEN_FILE          root-owned file containing the 1Password service account token

Optional config keys:
  OP_FIELD            optional field label or ID containing full dotenv content
  REQUIRED_KEYS       space-separated env names that must be present
  OUTPUT_FILE         generated env path; defaults to /var/db/uinaf/devbox-env/$IDENTITY/openclaw.env
  LINK_FILE           optional compatibility symlink path, usually $HOME/.openclaw/.env
  OP_CONFIG_DIR       root-owned op config dir; defaults to /var/db/uinaf/op-config/$IDENTITY
  OP_BIN              op binary path, defaults to /opt/homebrew/bin/op or op in PATH
  JQ_BIN              jq binary path, defaults to /opt/homebrew/bin/jq or jq in PATH
  INPUT_JSON_FILE     test-only: read item JSON from this path instead of calling op
  ALLOW_TEST_OUTPUT   test-only: allow non-production output path when INPUT_JSON_FILE is set
EOF
}

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

info() {
  printf '[devbox-env] %s\n' "$1"
}

stat_mode() {
  stat -f '%Lp' "$1"
}

stat_owner() {
  stat -f '%Su' "$1"
}

ensure_not_group_or_world_writable() {
  local path="$1"
  local mode

  mode="$(stat_mode "$path")"
  if [ $((8#$mode & 0022)) -ne 0 ]; then
    fail "$path is group/world writable"
  fi
}

ensure_root_controlled_when_root() {
  local path="$1"

  [ -e "$path" ] || fail "missing $path"
  ensure_not_group_or_world_writable "$path"

  if [ "$(id -u)" -eq 0 ] && [ "$(stat_owner "$path")" != "root" ]; then
    fail "$path must be owned by root"
  fi
}

resolve_tool() {
  local configured="$1"
  local fallback="$2"
  local name="$3"

  if [ -n "$configured" ]; then
    [ -x "$configured" ] || fail "$name is not executable: $configured"
    printf '%s\n' "$configured"
    return
  fi

  if [ -x "$fallback" ]; then
    printf '%s\n' "$fallback"
    return
  fi

  command -v "$name" || fail "missing required command: $name"
}

get_user_home() {
  local user="$1"
  local home

  if command -v dscl >/dev/null 2>&1; then
    home="$(dscl . -read "/Users/$user" NFSHomeDirectory 2>/dev/null | awk '{ print $2; exit }')"
    if [ -n "$home" ]; then
      printf '%s\n' "$home"
      return
    fi
  fi

  home="$(eval "printf '%s' ~$user")"
  [ "$home" != "~$user" ] || fail "could not resolve home for $user"
  printf '%s\n' "$home"
}

validate_env_name_list() {
  local label="$1"
  local words="$2"
  local key

  # shellcheck disable=SC2086
  for key in $words; do
    case "$key" in
      ''|*[!ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_]*)
        fail "$label contains invalid env name: $key"
        ;;
      [0123456789]*)
        fail "$label contains env name starting with digit: $key"
        ;;
    esac
  done
}

config_path="${1:-}"
if [ -z "$config_path" ] || [ "${config_path:-}" = "--help" ] || [ "${config_path:-}" = "-h" ]; then
  usage
  exit 2
fi

ensure_root_controlled_when_root "$config_path"

# The config is trusted local machine state after ownership/mode checks above.
# shellcheck disable=SC1090
. "$config_path"

: "${IDENTITY:?missing IDENTITY}"
: "${TARGET_USER:?missing TARGET_USER}"
: "${OP_ACCOUNT:?missing OP_ACCOUNT}"
: "${OP_VAULT:?missing OP_VAULT}"
: "${OP_ITEM:?missing OP_ITEM}"
: "${TOKEN_FILE:?missing TOKEN_FILE}"

id "$TARGET_USER" >/dev/null 2>&1 || fail "unknown target user: $TARGET_USER"

target_home="$(get_user_home "$TARGET_USER")"
default_output="/var/db/uinaf/devbox-env/$IDENTITY/openclaw.env"
output_file="${OUTPUT_FILE:-$default_output}"
op_field="${OP_FIELD:-}"
op_config_dir="${OP_CONFIG_DIR:-/var/db/uinaf/op-config/$IDENTITY}"
required_keys="${REQUIRED_KEYS:-}"
op_bin="$(resolve_tool "${OP_BIN:-}" /opt/homebrew/bin/op op)"
jq_bin="$(resolve_tool "${JQ_BIN:-}" /opt/homebrew/bin/jq jq)"
test_mode=0
if [ -n "${INPUT_JSON_FILE:-}" ] && [ "${ALLOW_TEST_OUTPUT:-}" = "1" ] && [ "$(id -u)" -ne 0 ]; then
  test_mode=1
fi

validate_env_name_list "REQUIRED_KEYS" "$required_keys"

if [ -n "$op_field" ]; then
  case "$op_field" in
    *$'\n'*|*$'\r'*)
      fail "OP_FIELD must be a single line"
      ;;
  esac
fi

case "$output_file" in
  /var/db/uinaf/devbox-env/"$IDENTITY"/openclaw.env)
    ;;
  *)
    [ "$test_mode" -eq 1 ] || fail "OUTPUT_FILE must be /var/db/uinaf/devbox-env/$IDENTITY/openclaw.env"
    ;;
esac

ensure_root_controlled_when_root "$TOKEN_FILE"
case "$(stat_mode "$TOKEN_FILE")" in
  400|600)
    ;;
  *)
    fail "$TOKEN_FILE mode must be 0400 or 0600"
    ;;
esac

mkdir -p "$op_config_dir"
if [ "$(id -u)" -eq 0 ]; then
  chown root:wheel "$op_config_dir"
fi
chmod 0700 "$op_config_dir"
ensure_root_controlled_when_root "$op_config_dir"

if [ -n "${INPUT_JSON_FILE:-}" ]; then
  ensure_root_controlled_when_root "$INPUT_JSON_FILE"
  item_json="$(cat "$INPUT_JSON_FILE")"
else
  token="$(tr -d '\n' < "$TOKEN_FILE")"
  [ -n "$token" ] || fail "$TOKEN_FILE is empty"
  item_json="$(OP_CONFIG_DIR="$op_config_dir" OP_SERVICE_ACCOUNT_TOKEN="$token" "$op_bin" item get "$OP_ITEM" \
    --account "$OP_ACCOUNT" \
    --vault "$OP_VAULT" \
    --format json)"
  unset token
fi

if [ -n "$op_field" ]; then
  # shellcheck disable=SC2016
  env_content="$(printf '%s' "$item_json" | "$jq_bin" -er --arg field "$op_field" '
    [
      .fields[]
      | select((.label // "") == $field or (.id // "") == $field)
      | select(.value != null)
      | .value
      | tostring
    ]
    | if length == 1 then .[0] else error("expected exactly one dotenv field") end
  ')" || fail "could not read exactly one dotenv field from 1Password item"
else
  # shellcheck disable=SC2016
  env_content="$(printf '%s' "$item_json" | "$jq_bin" -r '
    .fields[]
    | select(.value != null and (.value | tostring) != "")
    | select((.label // "") | test("^[A-Z_][A-Z0-9_]*$"))
    | "\(.label)=\(.value | tostring)"
  ')"
fi

[ -n "$env_content" ] || fail "no generated env fields found"

seen_keys=""
while IFS= read -r line; do
  [ -n "$line" ] || continue
  case "$line" in
    *=*)
      key="${line%%=*}"
      ;;
    *)
      fail "generated invalid dotenv line"
      ;;
  esac
  validate_env_name_list "generated output" "$key"
  if [ "$key" = "OP_SERVICE_ACCOUNT_TOKEN" ]; then
    fail "generated env must not contain OP_SERVICE_ACCOUNT_TOKEN"
  fi
  if printf '%s\n' "$seen_keys" | grep -Fxq "$key"; then
    fail "duplicate generated env key: $key"
  fi
  seen_keys="${seen_keys}${key}
"
done <<< "$env_content"

for key in $required_keys; do
  if ! printf '%s\n' "$seen_keys" | grep -Fxq "$key"; then
    fail "required key missing from generated env: $key"
  fi
done

output_dir="$(dirname "$output_file")"
mkdir -p "$output_dir"
if [ "$(id -u)" -eq 0 ]; then
  chown root:wheel "$output_dir"
fi
chmod 0711 "$output_dir"

if [ -e "$output_file" ] && [ -L "$output_file" ]; then
  fail "$output_file must not be a symlink"
fi

tmp="$(mktemp "$output_dir/.openclaw.env.tmp.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
printf '%s\n' "$env_content" > "$tmp"
if [ "$(id -u)" -eq 0 ]; then
  chown "$TARGET_USER":staff "$tmp"
fi
chmod 0400 "$tmp"
mv -f "$tmp" "$output_file"
trap - EXIT

if [ -n "${LINK_FILE:-}" ]; then
  case "$LINK_FILE" in
    "$target_home"/.openclaw/.env)
      ;;
    *)
      fail "LINK_FILE must be $target_home/.openclaw/.env"
      ;;
  esac

  openclaw_dir="$(dirname "$LINK_FILE")"
  if [ -e "$openclaw_dir" ] && [ -L "$openclaw_dir" ]; then
    fail "$openclaw_dir must not be a symlink"
  fi
  mkdir -p "$openclaw_dir"
  if [ "$(id -u)" -eq 0 ]; then
    chown "$TARGET_USER":staff "$openclaw_dir"
  fi
  chmod 0700 "$openclaw_dir"
  ln -sfn "$output_file" "$LINK_FILE"
  if [ "$(id -u)" -eq 0 ]; then
    chown -h "$TARGET_USER":staff "$LINK_FILE"
  fi
fi

info "wrote $(printf '%s\n' "$env_content" | wc -l | tr -d ' ') keys to $output_file"
