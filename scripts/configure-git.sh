#!/usr/bin/env bash
set -euo pipefail

non_interactive=0
profile="${DOTFILES_PROFILE:-}"
git_name="${GIT_USER_NAME:-}"
git_email="${GIT_USER_EMAIL:-}"
signing_key="${GIT_SIGNING_KEY:-}"
sign_commits="${GIT_SIGN_COMMITS:-}"
op_ssh_vault="${OP_SSH_VAULT:-}"

usage() {
  cat <<EOF
usage: $0 [--profile personal|devbox] [--non-interactive]

Writes:
  ~/.gitconfig.local
  ~/.config/1Password/ssh/agent.toml when OP_SSH_VAULT or prompt value is set

Environment:
  GIT_USER_NAME
  GIT_USER_EMAIL
  GIT_SIGNING_KEY
  GIT_SIGN_COMMITS    true|false
  OP_SSH_VAULT        optional 1Password SSH agent vault
  OP_SERVICE_ACCOUNT_TOKEN may be used by 1Password tooling, but is not read or written here
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      profile="${2:-}"
      if [ -z "$profile" ]; then
        printf '%s\n' '--profile requires a value' >&2
        exit 2
      fi
      shift 2
      ;;
    --non-interactive)
      non_interactive=1
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

prompt() {
  local label="$1"
  local default="$2"
  local value

  if [ "$non_interactive" -eq 1 ]; then
    printf '%s' "$default"
    return
  fi

  if [ -n "$default" ]; then
    printf '%s [%s]: ' "$label" "$default" >&2
  else
    printf '%s: ' "$label" >&2
  fi

  read -r value
  printf '%s' "${value:-$default}"
}

default_name="$(git config --global --get user.name 2>/dev/null || true)"
default_email="$(git config --global --get user.email 2>/dev/null || true)"

case "$profile" in
  devbox)
    sign_commits="${sign_commits:-true}"
    ;;
  "")
    profile="$(prompt 'Profile (personal/devbox)' personal)"
    if [ "$profile" = "devbox" ]; then
      sign_commits="${sign_commits:-true}"
    fi
    ;;
  personal)
    ;;
esac

if [ "$profile" != "personal" ] && [ "$profile" != "devbox" ]; then
  printf 'unsupported profile: %s\n' "$profile" >&2
  exit 2
fi

git_name="${git_name:-$(prompt 'Git user.name' "$default_name")}"
git_email="${git_email:-$(prompt 'Git user.email' "$default_email")}"

if [ -z "$git_name" ] || [ -z "$git_email" ]; then
  printf 'git user.name and user.email are required\n' >&2
  exit 1
fi

if [ -z "$signing_key" ] && [ "${sign_commits:-}" != "false" ]; then
  signing_key="$(prompt 'Git SSH signing public key (blank to disable signing)' '')"
fi

if [ -z "${sign_commits:-}" ]; then
  if [ -n "$signing_key" ]; then
    sign_commits="true"
  else
    sign_commits="false"
  fi
fi

if [ "$sign_commits" != "true" ] && [ "$sign_commits" != "false" ]; then
  printf 'GIT_SIGN_COMMITS must be true or false\n' >&2
  exit 2
fi

if [ "$sign_commits" = "true" ] && [ -z "$signing_key" ]; then
  printf 'commit signing is enabled but GIT_SIGNING_KEY is empty\n' >&2
  printf 'set GIT_SIGNING_KEY to the SSH public signing key, or set GIT_SIGN_COMMITS=false\n' >&2
  exit 1
fi

gitconfig_local="$HOME/.gitconfig.local"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

{
  printf '[user]\n'
  printf '\tname = %s\n' "$git_name"
  printf '\temail = %s\n' "$git_email"
  if [ -n "$signing_key" ]; then
    printf '\tsigningkey = %s\n' "$signing_key"
  fi
  printf '\n[commit]\n'
  printf '\tgpgsign = %s\n' "$sign_commits"
  printf '\n[tag]\n'
  printf '\tgpgsign = %s\n' "$sign_commits"
} > "$tmp"

if [ -L "$gitconfig_local" ]; then
  unlink "$gitconfig_local"
fi

install -m 0600 "$tmp" "$gitconfig_local"
printf 'wrote %s\n' "$gitconfig_local"

if [ -z "$op_ssh_vault" ] && [ "$non_interactive" -eq 0 ]; then
  op_ssh_vault="$(prompt '1Password SSH agent vault (blank to skip)' "$op_ssh_vault")"
fi

if [ -n "$op_ssh_vault" ]; then
  op_agent_config="$HOME/.config/1Password/ssh/agent.toml"

  mkdir -p "$(dirname "$op_agent_config")"
  if [ -L "$op_agent_config" ]; then
    unlink "$op_agent_config"
  fi

  cat > "$op_agent_config" <<EOF
[[ssh-keys]]
vault = "$op_ssh_vault"
EOF
  chmod 0600 "$op_agent_config"
  printf 'wrote %s\n' "$op_agent_config"
else
  printf 'skipped 1Password SSH agent config\n'
fi
