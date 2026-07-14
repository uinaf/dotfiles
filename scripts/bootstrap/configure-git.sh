#!/usr/bin/env bash
set -euo pipefail

non_interactive=0
profile="${DOTFILES_PROFILE:-}"
git_name="${GIT_USER_NAME:-}"
git_email="${GIT_USER_EMAIL:-}"
signing_key="${GIT_SIGNING_KEY:-}"
agentless_signing_program="$HOME/.local/libexec/uinaf/git-ssh-sign-agentless"
sign_commits="${GIT_SIGN_COMMITS:-}"
allowed_signer_principal="${GIT_ALLOWED_SIGNER_PRINCIPAL:-}"
git_ssh_identity_file="${GIT_SSH_IDENTITY_FILE:-}"

usage() {
  cat <<EOF
usage: $0 [--profile personal|devbox] [--non-interactive]

Writes:
  ~/.gitconfig.local
  ~/.ssh/github.config when GIT_SSH_IDENTITY_FILE is set or inferred

Environment:
  GIT_USER_NAME
  GIT_USER_EMAIL
  GIT_SIGNING_KEY    unencrypted local SSH private key path
  GIT_SIGN_COMMITS    true|false
  GIT_ALLOWED_SIGNER_PRINCIPAL optional SSH signing verification principal; defaults to GIT_USER_EMAIL
  GIT_SSH_IDENTITY_FILE optional SSH private key path for git@github.com; devbox defaults to GIT_SIGNING_KEY
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

mode_of() {
  local path="$1"

  if stat -f '%Lp' "$path" >/dev/null 2>&1; then
    stat -f '%Lp' "$path"
  else
    stat -c '%a' "$path"
  fi
}

validate_local_ssh_private_key() {
  local purpose="$1"
  local identity_file="$2"
  local identity_mode

  if [ ! -f "$identity_file" ]; then
    printf 'cannot configure %s; key file does not exist: %s\n' "$purpose" "$identity_file" >&2
    exit 1
  fi

  if [ ! -r "$identity_file" ]; then
    printf 'cannot configure %s; key file is not readable: %s\n' "$purpose" "$identity_file" >&2
    exit 1
  fi

  if ! sed -n '1p' "$identity_file" | grep -Eq '^-----BEGIN ([A-Z0-9]+ )?PRIVATE KEY-----$'; then
    printf 'cannot configure %s; key file is not an SSH private key: %s\n' "$purpose" "$identity_file" >&2
    exit 1
  fi

  if ! ssh-keygen -lf "$identity_file" >/dev/null 2>&1; then
    printf 'cannot configure %s; key file is not a valid SSH private key: %s\n' "$purpose" "$identity_file" >&2
    exit 1
  fi

  if [ ! -O "$identity_file" ]; then
    printf 'cannot configure %s; key file is not owned by the current user: %s\n' "$purpose" "$identity_file" >&2
    exit 1
  fi

  identity_mode="$(mode_of "$identity_file")"
  if [ $((8#$identity_mode & 0077)) -ne 0 ]; then
    printf 'cannot configure %s; key file permissions must be owner-only: %s (mode %s)\n' "$purpose" "$identity_file" "$identity_mode" >&2
    printf 'run: chmod 0600 %s\n' "$identity_file" >&2
    exit 1
  fi
}

validate_github_ssh_config() {
  local ssh_config_dir="$HOME/.ssh"
  local ssh_config_local="$ssh_config_dir/config.local"
  local ssh_github_config="$ssh_config_dir/github.config"

  if [ -L "$ssh_github_config" ]; then
    printf 'cannot configure git@github.com SSH auth; existing path is a symlink: %s\n' "$ssh_github_config" >&2
    printf 'move it aside before rerunning configure-git.sh\n' >&2
    exit 1
  fi

  if [ -e "$ssh_github_config" ] && [ ! -f "$ssh_github_config" ]; then
    printf 'cannot configure git@github.com SSH auth; existing path is not a regular file: %s\n' "$ssh_github_config" >&2
    printf 'move it aside before rerunning configure-git.sh\n' >&2
    exit 1
  fi

  if [ -f "$ssh_github_config" ] && ! awk '
    $0 == "# uinaf-dotfiles: github-ssh begin" {
      if (managed || blocks) exit 1
      managed = 1
      blocks = 1
      next
    }
    $0 == "# uinaf-dotfiles: github-ssh end" {
      if (!managed) exit 1
      managed = 0
      next
    }
    !managed && $0 !~ /^[[:space:]]*$/ { unmanaged = 1 }
    END {
      if (managed || blocks != 1 || unmanaged) exit 1
    }
  ' "$ssh_github_config"; then
    printf 'cannot configure git@github.com SSH auth; existing file is not managed exclusively by uinaf dotfiles: %s\n' "$ssh_github_config" >&2
    printf 'move it aside or migrate its directives to ~/.ssh/config.local before rerunning configure-git.sh\n' >&2
    exit 1
  fi

  [ -f "$ssh_config_local" ] || return 0

  if ! awk '
    $0 == "# uinaf-dotfiles: github-ssh begin" {
      if (managed) exit 1
      managed = 1
      next
    }
    $0 == "# uinaf-dotfiles: github-ssh end" {
      if (!managed) exit 1
      managed = 0
      next
    }
    END {
      if (managed) exit 1
    }
  ' "$ssh_config_local"; then
    printf 'cannot configure git@github.com SSH auth; malformed managed block in %s\n' "$ssh_config_local" >&2
    exit 1
  fi

  if awk '
    $0 == "# uinaf-dotfiles: github-ssh begin" { managed = 1; next }
    $0 == "# uinaf-dotfiles: github-ssh end" { managed = 0; next }
    !managed {
      line = $0
      sub(/^[[:space:]]*/, "", line)
      if (tolower(line) ~ /^host[[:space:]=]/) {
        sub(/^[Hh][Oo][Ss][Tt][[:space:]=]+/, "", line)
        sub(/[[:space:]]*#.*/, "", line)
        count = split(line, patterns, /[[:space:]]+/)
        for (i = 1; i <= count; i++) {
          if (tolower(patterns[i]) == "github.com") unmanaged_github = 1
        }
      }
    }
    END {
      exit unmanaged_github ? 0 : 1
    }
  ' "$ssh_config_local"; then
    printf 'cannot configure git@github.com SSH auth; unmanaged Host github.com entry exists in %s\n' "$ssh_config_local" >&2
    printf 'remove or migrate that entry before rerunning configure-git.sh\n' >&2
    exit 1
  fi
}

write_github_ssh_config() (
  local identity_file="$1"
  local ssh_config_dir="$HOME/.ssh"
  local ssh_config_local="$ssh_config_dir/config.local"
  local ssh_github_config="$ssh_config_dir/github.config"
  local tmp_github
  local tmp_local
  local migrate_local=0

  mkdir -p "$ssh_config_dir"
  chmod 0700 "$ssh_config_dir"

  tmp_github="$(mktemp)"
  tmp_local="$(mktemp)"
  trap 'rm -f "$tmp_github" "$tmp_local"' EXIT

  cat > "$tmp_github" <<EOF
# uinaf-dotfiles: github-ssh begin
Host github.com
  HostName github.com
  User git
  IdentityFile $identity_file
  IdentitiesOnly yes
  IdentityAgent none
# uinaf-dotfiles: github-ssh end
EOF

  if [ -f "$ssh_config_local" ] && grep -q '^# uinaf-dotfiles: github-ssh begin$' "$ssh_config_local"; then
    migrate_local=1
    awk '
      $0 == "# uinaf-dotfiles: github-ssh begin" { skip = 1; next }
      $0 == "# uinaf-dotfiles: github-ssh end" { skip = 0; next }
      !skip { print }
    ' "$ssh_config_local" > "$tmp_local"
  fi

  install -m 0600 "$tmp_github" "$ssh_github_config"
  printf 'wrote %s\n' "$ssh_github_config"

  if [ "$migrate_local" -eq 1 ]; then
    install -m 0600 "$tmp_local" "$ssh_config_local"
    printf 'migrated managed GitHub block out of %s\n' "$ssh_config_local"
  fi
)

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
  signing_key="$(prompt 'Git SSH private key path (blank to disable signing)' '')"
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
  printf 'set GIT_SIGNING_KEY to an unencrypted local SSH private key, or set GIT_SIGN_COMMITS=false\n' >&2
  exit 1
fi

signing_public_key=""
if [ "$sign_commits" = "true" ]; then
  validate_local_ssh_private_key "Git signing" "$signing_key"
  if ! signing_public_key="$(ssh-keygen -y -P '' -f "$signing_key" 2>/dev/null)"; then
    printf 'cannot configure Git signing; GIT_SIGNING_KEY must be an unencrypted SSH private key: %s\n' "$signing_key" >&2
    exit 1
  fi
  if [ ! -x "$agentless_signing_program" ]; then
    printf 'cannot configure Git signing; agentless signer is missing or not executable: %s\n' "$agentless_signing_program" >&2
    printf 'run scripts/bootstrap/install.sh before configure-git.sh\n' >&2
    exit 1
  fi
fi

if [ -z "$git_ssh_identity_file" ] && [ "$profile" = "devbox" ]; then
  git_ssh_identity_file="$signing_key"
fi

if [ -n "$git_ssh_identity_file" ]; then
  validate_local_ssh_private_key "git@github.com SSH auth" "$git_ssh_identity_file"
  validate_github_ssh_config
fi

gitconfig_local="$HOME/.gitconfig.local"
allowed_signers_file="$HOME/.config/git/allowed_signers.local"
tmp_gitconfig="$(mktemp)"
tmp_signers=""
trap 'rm -f "$tmp_gitconfig" ${tmp_signers:+"$tmp_signers"}' EXIT

if [ "$sign_commits" = "true" ]; then
  allowed_signer_principal="${allowed_signer_principal:-$git_email}"
  mkdir -p "$(dirname "$allowed_signers_file")"
  tmp_signers="$(mktemp)"
  printf '%s %s\n' "$allowed_signer_principal" "$signing_public_key" > "$tmp_signers"
fi

{
  printf '[user]\n'
  printf '\tname = %s\n' "$git_name"
  printf '\temail = %s\n' "$git_email"
  if [ "$sign_commits" = "true" ]; then
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
  if [ "$sign_commits" = "true" ]; then
    printf '\n[gpg "ssh"]\n'
    printf '\tallowedSignersFile = %s\n' "$allowed_signers_file"
    printf '\tprogram = %s\n' "$agentless_signing_program"
  fi
} > "$tmp_gitconfig"

if [ -n "$git_ssh_identity_file" ]; then
  write_github_ssh_config "$git_ssh_identity_file"
fi

if [ "$sign_commits" = "true" ]; then
  install -m 0600 "$tmp_signers" "$allowed_signers_file"
  printf 'wrote %s\n' "$allowed_signers_file"
fi

if [ -L "$gitconfig_local" ]; then
  unlink "$gitconfig_local"
fi

install -m 0600 "$tmp_gitconfig" "$gitconfig_local"
printf 'wrote %s\n' "$gitconfig_local"
