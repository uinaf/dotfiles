#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

identity=""
target_user=""
op_account=""
op_vault=""
op_item="OPENCLAW_ENV"
op_field=""
required_keys=""
start_interval="3600"
load_now=0

usage() {
  cat <<'EOF'
usage: sudo scripts/devbox/install-env-refresh.sh --identity ID --target-user USER --op-account ACCOUNT --op-vault VAULT [options]

Installs the root-owned devbox env refresh helper and LaunchDaemon.
This script does not install or read the service-account token.

Options:
  --op-item ITEM             1Password item title or ID (default: OPENCLAW_ENV)
  --op-field FIELD           optional field label or ID containing full dotenv content
  --required-keys KEYS      space-separated required env names
  --start-interval SECONDS  launchd StartInterval (default: 3600)
  --load                    bootstrap and kickstart the LaunchDaemon
  -h, --help
EOF
}

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

shell_quote() {
  printf '%q' "$1"
}

prepare_log_file() {
  local path="$1"

  if [ -L "$path" ]; then
    fail "$path must not be a symlink"
  fi

  touch "$path"
  chown root:wheel "$path"
  chmod 0640 "$path"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --identity)
      identity="${2:-}"
      shift 2
      ;;
    --target-user)
      target_user="${2:-}"
      shift 2
      ;;
    --op-account)
      op_account="${2:-}"
      shift 2
      ;;
    --op-vault)
      op_vault="${2:-}"
      shift 2
      ;;
    --op-item)
      op_item="${2:-}"
      shift 2
      ;;
    --op-field)
      op_field="${2:-}"
      shift 2
      ;;
    --required-keys)
      required_keys="${2:-}"
      shift 2
      ;;
    --start-interval)
      start_interval="${2:-}"
      shift 2
      ;;
    --load)
      load_now=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[ "$(id -u)" -eq 0 ] || fail "must run as root"
[ -n "$identity" ] || fail "missing --identity"
[ -n "$target_user" ] || fail "missing --target-user"
[ -n "$op_account" ] || fail "missing --op-account"
[ -n "$op_vault" ] || fail "missing --op-vault"
id "$target_user" >/dev/null 2>&1 || fail "unknown target user: $target_user"

case "$identity" in
  ''|*[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-]*)
    fail "identity may contain only letters, numbers, underscore, and dash"
    ;;
esac

case "$start_interval" in
  ''|*[!0123456789]*)
    fail "--start-interval must be a positive integer"
    ;;
esac
[ "$start_interval" -gt 0 ] || fail "--start-interval must be greater than zero"

helper_dir="/usr/local/libexec/uinaf"
helper_path="$helper_dir/devbox-refresh-openclaw-env"
state_dir="/var/db/uinaf"
config_dir="$state_dir/devbox-env-refresh"
secret_base_dir="$state_dir/devbox-secrets"
secret_dir="$secret_base_dir/$identity"
env_base_dir="$state_dir/devbox-env"
env_dir="$env_base_dir/$identity"
op_config_base_dir="$state_dir/op-config"
op_config_dir="$op_config_base_dir/$identity"
config_path="$config_dir/$identity.env"
token_file="$secret_dir/op-sa-token"
output_file="$env_dir/openclaw.env"
target_home="$(dscl . -read "/Users/$target_user" NFSHomeDirectory | awk '{ print $2; exit }')"
[ -n "$target_home" ] || fail "could not resolve home for $target_user"
link_file="$target_home/.openclaw/.env"
plist_path="/Library/LaunchDaemons/com.uinaf.devbox-env-refresh.$identity.plist"
label="com.uinaf.devbox-env-refresh.$identity"
log_path="/var/log/uinaf-devbox-env-refresh.$identity.log"
err_path="/var/log/uinaf-devbox-env-refresh.$identity.err.log"

install -d -o root -g wheel -m 0755 "$helper_dir"
install -o root -g wheel -m 0755 "$repo_root/scripts/devbox/refresh-openclaw-env.sh" "$helper_path"

install -d -o root -g wheel -m 0711 "$state_dir" "$env_base_dir" "$env_dir"
install -d -o root -g wheel -m 0700 "$config_dir" "$secret_base_dir" "$secret_dir" "$op_config_base_dir" "$op_config_dir"

tmp_config="$(mktemp "$config_dir/$identity.env.tmp.XXXXXX")"
{
  printf 'IDENTITY=%s\n' "$(shell_quote "$identity")"
  printf 'TARGET_USER=%s\n' "$(shell_quote "$target_user")"
  printf 'OP_ACCOUNT=%s\n' "$(shell_quote "$op_account")"
  printf 'OP_VAULT=%s\n' "$(shell_quote "$op_vault")"
  printf 'OP_ITEM=%s\n' "$(shell_quote "$op_item")"
  if [ -n "$op_field" ]; then
    printf 'OP_FIELD=%s\n' "$(shell_quote "$op_field")"
  fi
  printf 'OP_CONFIG_DIR=%s\n' "$(shell_quote "$op_config_dir")"
  printf 'TOKEN_FILE=%s\n' "$(shell_quote "$token_file")"
  if [ -n "$required_keys" ]; then
    printf 'REQUIRED_KEYS=%s\n' "$(shell_quote "$required_keys")"
  fi
  printf 'OUTPUT_FILE=%s\n' "$(shell_quote "$output_file")"
  printf 'LINK_FILE=%s\n' "$(shell_quote "$link_file")"
} > "$tmp_config"
install -o root -g wheel -m 0600 "$tmp_config" "$config_path"
rm -f "$tmp_config"

tmp_plist="$(mktemp "$config_dir/$identity.plist.tmp.XXXXXX")"
cat > "$tmp_plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$helper_path</string>
    <string>$config_path</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>$start_interval</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>$log_path</string>
  <key>StandardErrorPath</key>
  <string>$err_path</string>
</dict>
</plist>
EOF
plutil -lint "$tmp_plist" >/dev/null
install -o root -g wheel -m 0644 "$tmp_plist" "$plist_path"
rm -f "$tmp_plist"

prepare_log_file "$log_path"
prepare_log_file "$err_path"

printf 'installed helper: %s\n' "$helper_path"
printf 'installed config: %s\n' "$config_path"
printf 'installed plist: %s\n' "$plist_path"
printf 'prepared logs: %s, %s\n' "$log_path" "$err_path"
printf 'token file expected at: %s\n' "$token_file"

if [ "$load_now" -eq 1 ]; then
  launchctl bootout system "$plist_path" >/dev/null 2>&1 || true
  launchctl bootstrap system "$plist_path"
  launchctl kickstart -k "system/$label"
  printf 'loaded %s\n' "$label"
fi
