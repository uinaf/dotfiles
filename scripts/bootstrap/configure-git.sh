#!/usr/bin/env bash
set -euo pipefail

non_interactive=0
profile="${DOTFILES_PROFILE:-}"
git_name="${GIT_USER_NAME:-}"
git_email="${GIT_USER_EMAIL:-}"
signing_key="${GIT_SIGNING_KEY:-}"
sign_commits="${GIT_SIGN_COMMITS:-}"
allowed_signer_principal="${GIT_ALLOWED_SIGNER_PRINCIPAL:-}"
op_ssh_vault="${OP_SSH_VAULT:-}"
git_ssh_identity_file="${GIT_SSH_IDENTITY_FILE:-}"

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
  GIT_ALLOWED_SIGNER_PRINCIPAL optional SSH signing verification principal; defaults to GIT_USER_EMAIL
  GIT_SSH_IDENTITY_FILE optional SSH private key path for git@github.com; devbox defaults to GIT_SIGNING_KEY when it is a path
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

toml_basic_string() {
  local value="$1"

  case "$value" in
    *$'\n'*|*$'\r'*)
      printf 'TOML string values cannot contain newlines\n' >&2
      exit 2
      ;;
  esac

  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

resolve_ssh_public_key() {
  local value="$1"

  if [[ "$value" = ssh-* ]]; then
    printf '%s\n' "$value"
    return
  fi

  if [ -f "$value" ]; then
    if [[ "$value" = *.pub ]]; then
      sed -n '1p' "$value"
      return
    fi

    if [ -f "$value.pub" ]; then
      sed -n '1p' "$value.pub"
      return
    fi

    ssh-keygen -y -f "$value"
    return
  fi

  printf 'cannot resolve SSH public key from GIT_SIGNING_KEY=%s\n' "$value" >&2
  exit 1
}

write_github_ssh_config() {
  local identity_file="$1"
  local ssh_config_dir="$HOME/.ssh"
  local ssh_config_local="$ssh_config_dir/config.local"
  local tmp_config

  case "$identity_file" in
    ssh-*|"")
      return
      ;;
  esac

  if [ ! -f "$identity_file" ]; then
    printf 'cannot configure git@github.com SSH auth; identity file does not exist: %s\n' "$identity_file" >&2
    exit 1
  fi

  mkdir -p "$ssh_config_dir"
  chmod 0700 "$ssh_config_dir"

  tmp_config="$(mktemp)"
  if [ -f "$ssh_config_local" ]; then
    awk '
      $0 == "# uinaf-dotfiles: github-ssh begin" { skip = 1; next }
      $0 == "# uinaf-dotfiles: github-ssh end" { skip = 0; next }
      $1 == "Host" && $2 == "github.com" { skip_github = 1; next }
      $1 == "Host" { skip_github = 0 }
      !skip && !skip_github { print }
    ' "$ssh_config_local" > "$tmp_config"
    if [ -s "$tmp_config" ] && [ "$(tail -c 1 "$tmp_config")" != "" ]; then
      printf '\n' >> "$tmp_config"
    fi
  fi

  cat >> "$tmp_config" <<EOF
# uinaf-dotfiles: github-ssh begin
Host github.com
  HostName github.com
  User git
  IdentityFile $identity_file
  IdentitiesOnly yes
  IdentityAgent none
# uinaf-dotfiles: github-ssh end
EOF

  install -m 0600 "$tmp_config" "$ssh_config_local"
  rm -f "$tmp_config"
  printf 'wrote %s\n' "$ssh_config_local"
}

default_git_ssh_identity_file() {
  local value="$1"

  case "$value" in
    ssh-*|"")
      return
      ;;
    *.pub)
      if [ -f "${value%.pub}" ]; then
        printf '%s\n' "${value%.pub}"
      else
        printf '%s\n' "$value"
      fi
      ;;
    *)
      printf '%s\n' "$value"
      ;;
  esac
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

if [ -z "$git_ssh_identity_file" ] && [ "$profile" = "devbox" ]; then
  case "$signing_key" in
    ssh-*)
      ;;
    *)
      git_ssh_identity_file="$(default_git_ssh_identity_file "$signing_key")"
      ;;
  esac
else
  git_ssh_identity_file="$(default_git_ssh_identity_file "$git_ssh_identity_file")"
fi

gitconfig_local="$HOME/.gitconfig.local"
allowed_signers_file="$HOME/.config/git/allowed_signers.local"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

if [ "$sign_commits" = "true" ]; then
  allowed_signer_principal="${allowed_signer_principal:-$git_email}"
  signing_public_key="$(resolve_ssh_public_key "$signing_key")"
  mkdir -p "$(dirname "$allowed_signers_file")"
  printf '%s %s\n' "$allowed_signer_principal" "$signing_public_key" > "$allowed_signers_file"
  chmod 0600 "$allowed_signers_file"
  printf 'wrote %s\n' "$allowed_signers_file"
fi

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
  if [ "$profile" = "devbox" ]; then
    printf '\n[safe]\n'
    printf '\tdirectory = /opt/homebrew\n'
  fi
  if [ "$sign_commits" = "true" ] || [ -n "$op_ssh_vault" ]; then
    printf '\n[gpg "ssh"]\n'
    if [ "$sign_commits" = "true" ]; then
      printf '\tallowedSignersFile = %s\n' "$allowed_signers_file"
    fi
    if [ -n "$op_ssh_vault" ]; then
      printf '\tprogram = /Applications/1Password.app/Contents/MacOS/op-ssh-sign\n'
    fi
  fi
} > "$tmp"

if [ -L "$gitconfig_local" ]; then
  unlink "$gitconfig_local"
fi

install -m 0600 "$tmp" "$gitconfig_local"
printf 'wrote %s\n' "$gitconfig_local"

if [ "$profile" = "devbox" ]; then
  write_github_ssh_config "$git_ssh_identity_file"
fi

if [ -z "$op_ssh_vault" ] && [ "$non_interactive" -eq 0 ]; then
  op_ssh_vault="$(prompt '1Password SSH agent vault (blank to skip)' "$op_ssh_vault")"
fi

if [ -n "$op_ssh_vault" ]; then
  op_agent_config="$HOME/.config/1Password/ssh/agent.toml"
  op_ssh_vault_toml="$(toml_basic_string "$op_ssh_vault")"

  mkdir -p "$(dirname "$op_agent_config")"
  if [ -L "$op_agent_config" ]; then
    unlink "$op_agent_config"
  fi

  cat > "$op_agent_config" <<EOF
[[ssh-keys]]
vault = $op_ssh_vault_toml
EOF
  chmod 0600 "$op_agent_config"
  printf 'wrote %s\n' "$op_agent_config"
else
  printf 'skipped 1Password SSH agent config\n'
fi
