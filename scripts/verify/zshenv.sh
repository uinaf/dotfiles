#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
zshenv="$repo_root/chezmoi/dot_zshenv"
test_home="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-zshenv.XXXXXX")"

cleanup() {
  rm -rf "$test_home"
}
trap cleanup EXIT

mkdir -p "$test_home/.config/dotfiles"
chmod 700 "$test_home/.config" "$test_home/.config/dotfiles"
ln -s "$zshenv" "$test_home/.zshenv"

run_zshenv() {
  env -i HOME="$test_home" PATH=/usr/bin:/bin /bin/zsh -c "$1"
}

git -C "$repo_root" check-ignore -q .config/dotfiles/zshenv.local || {
  printf 'FAILED: local overlay is not ignored by Git\n' >&2
  exit 1
}
for config_source in dot_config private_dot_config; do
  for dotfiles_source in dotfiles private_dotfiles; do
    for overlay_source in \
      zshenv.local private_zshenv.local \
      zshenv.local.tmpl private_zshenv.local.tmpl; do
      source_path="chezmoi/$config_source/$dotfiles_source/$overlay_source"
      git -C "$repo_root" check-ignore -q "$source_path" || {
        printf 'FAILED: overlay source path is not ignored by Git: %s\n' "$source_path" >&2
        exit 1
      }
    done
  done
done
unset config_source dotfiles_source overlay_source source_path

# shellcheck disable=SC2016 # zsh evaluates the assertion body
run_zshenv '
  [[ "$LANG" == en_US.UTF-8 ]] || {
    print -u2 "FAILED: shared zshenv did not establish its default export"
    exit 1
  }
  [[ -z ${DOTFILES_ZSHENV_LOCAL+x} ]] || {
    print -u2 "FAILED: missing overlay leaked DOTFILES_ZSHENV_LOCAL"
    exit 1
  }
  [[ -z ${HOMEBREW_NO_AUTO_UPDATE+x} ]] || {
    print -u2 "FAILED: non-devbox shell disabled Homebrew auto-update"
    exit 1
  }
'

: >"$test_home/.config/dotfiles/devbox.env"
chmod 600 "$test_home/.config/dotfiles/devbox.env"

# shellcheck disable=SC2016 # zsh evaluates the assertion body
run_zshenv '
  [[ "$AGENT_CLI_CREDENTIAL_STORE" == file ]] || {
    print -u2 "FAILED: devbox shell omitted the agent credential store"
    exit 1
  }
  [[ "$HOMEBREW_NO_AUTO_UPDATE" == 1 ]] || {
    print -u2 "FAILED: devbox shell allowed Homebrew auto-update"
    exit 1
  }
'

printf 'export DOTFILES_ZSHENV_LOCAL=from-local\nexport LANG=overlay-wins\n' \
  >"$test_home/.config/dotfiles/zshenv.local"
chmod 600 "$test_home/.config/dotfiles/zshenv.local"

command -v chezmoi >/dev/null 2>&1 || {
  printf 'FAILED: chezmoi is required to verify the local overlay boundary\n' >&2
  exit 1
}
test_source="$test_home/chezmoi"
cp -R "$repo_root/chezmoi" "$test_source"
for profile in workstation personal-workstation personal-devbox devbox assistant; do
  override_data="$(printf '{"dotfilesProfile":"%s"}' "$profile")"
  control_file="$test_home/.config/dotfiles/zshenv.$profile.control"
  printf 'control\n' >"$control_file"
  chmod 600 "$control_file"
  if ! add_output="$(
    HOME="$test_home" chezmoi \
      --source "$test_source" \
      --destination "$test_home" \
      --override-data "$override_data" \
      add "$control_file" 2>&1
  )"; then
    printf 'FAILED: Chezmoi positive control failed for %s: %s\n' "$profile" "$add_output" >&2
    exit 1
  fi
  if ! find "$test_source" -type f -name "*zshenv.$profile.control" -print -quit | grep -q .; then
    printf 'FAILED: Chezmoi positive control did not add its source for %s\n' "$profile" >&2
    exit 1
  fi
  if ! add_output="$(
    HOME="$test_home" chezmoi \
      --source "$test_source" \
      --destination "$test_home" \
      --override-data "$override_data" \
      add "$test_home/.config/dotfiles/zshenv.local" 2>&1
  )"; then
    printf 'FAILED: cannot verify Chezmoi ignore for %s: %s\n' "$profile" "$add_output" >&2
    exit 1
  fi
  if find "$test_source" -type f -name '*zshenv.local' -print -quit | grep -q .; then
    printf 'FAILED: Chezmoi added the local overlay for %s\n' "$profile" >&2
    exit 1
  fi
done
rm -rf "$test_source"
unset add_output control_file override_data profile test_source

# shellcheck disable=SC2016 # zsh evaluates the assertion body
run_zshenv '
  [[ "$DOTFILES_ZSHENV_LOCAL" == from-local ]] || {
    print -u2 "FAILED: overlay did not export DOTFILES_ZSHENV_LOCAL"
    exit 1
  }
  [[ "$LANG" == overlay-wins ]] || {
    print -u2 "FAILED: overlay did not override an earlier export"
    exit 1
  }
'

mv "$test_home/.config/dotfiles/zshenv.local" "$test_home/zshenv.external"
ln -s "$test_home/zshenv.external" "$test_home/.config/dotfiles/zshenv.local"

# shellcheck disable=SC2016 # zsh evaluates the assertion body
run_zshenv '
  [[ -z ${DOTFILES_ZSHENV_LOCAL+x} ]] || {
    print -u2 "FAILED: symlink overlay was sourced"
    exit 1
  }
'

rm "$test_home/.config/dotfiles/zshenv.local"
mv "$test_home/zshenv.external" "$test_home/.config/dotfiles/zshenv.local"

if [ "$(id -u)" -ne 0 ]; then
  chmod 000 "$test_home/.config/dotfiles/zshenv.local"

  # shellcheck disable=SC2016 # zsh evaluates the assertion body
  run_zshenv '
    [[ -z ${DOTFILES_ZSHENV_LOCAL+x} ]] || {
      print -u2 "FAILED: unreadable overlay was sourced"
      exit 1
    }
  '

  chmod 600 "$test_home/.config/dotfiles/zshenv.local"
else
  printf 'SKIPPED: unreadable overlay check requires a non-root user\n' >&2
fi

rm "$test_home/.config/dotfiles/zshenv.local"
mkdir "$test_home/.config/dotfiles/zshenv.local"

# shellcheck disable=SC2016 # zsh evaluates the assertion body
run_zshenv '
  [[ -z ${DOTFILES_ZSHENV_LOCAL+x} ]] || {
    print -u2 "FAILED: directory overlay was sourced"
    exit 1
  }
'

rmdir "$test_home/.config/dotfiles/zshenv.local"
mv "$test_home/.config/dotfiles" "$test_home/dotfiles.external"
ln -s "$test_home/dotfiles.external" "$test_home/.config/dotfiles"
printf 'export DOTFILES_ZSHENV_LOCAL=from-parent-link\n' \
  >"$test_home/dotfiles.external/zshenv.local"
chmod 600 "$test_home/dotfiles.external/zshenv.local"

# shellcheck disable=SC2016 # zsh evaluates the assertion body
run_zshenv '
  [[ -z ${DOTFILES_ZSHENV_LOCAL+x} ]] || {
    print -u2 "FAILED: overlay under a symlinked parent was sourced"
    exit 1
  }
'

printf 'zshenv overlay ok\n'
