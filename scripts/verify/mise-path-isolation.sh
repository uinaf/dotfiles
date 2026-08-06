#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
mkdir -p "$tmp_dir/bin" "$tmp_dir/home"

# shellcheck source=scripts/lib/shell-probe.sh
. "$repo_root/scripts/lib/shell-probe.sh"

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

cat >"$tmp_dir/bin/zsh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

probe_log="${HOME}/.probe.log"
warn_flag="${HOME}/.fake-mise-doctor-warn"

{
  printf 'flags=%s\n' "$*"
  printf 'path=%s\n' "${PATH:-}"
  printf 'zdotdir=%s\n' "${ZDOTDIR:-}"
  printf 'xdg_config=%s\n' "${XDG_CONFIG_HOME:-}"
  printf 'mise_config=%s\n' "${MISE_CONFIG_DIR:-}"
  printf 'mise_shell=%s\n' "${MISE_SHELL:-}"
  printf 'mise_session=%s\n' "${__MISE_SESSION:-}"
  printf 'mise_orig_path=%s\n' "${__MISE_ORIG_PATH:-}"
  printf 'mise_activate_path=%s\n' "${__MISE_ZSH_ACTIVATE_PATH:-}"
} >"$probe_log"

case "$*" in
  *'mise doctor'*)
    if [ -f "$warn_flag" ]; then
      cat <<'WARN'
2 warnings found:

1. mise tool paths are not first in PATH. These paths take precedence:
     /opt/homebrew/sbin
WARN
    else
      printf 'activated: yes\n1 warning found:\n\n1. unrelated warning\n'
    fi
    ;;
  *'print -l'*)
    printf '%s\n' "${PATH:-}" | tr ':' '\n' | nl -ba
    ;;
  *)
    printf 'unexpected zsh invocation: %s\n' "$*" >&2
    exit 99
    ;;
esac
EOF
chmod 755 "$tmp_dir/bin/zsh"

probe_log="$tmp_dir/home/.probe.log"
: >"$probe_log"
rm -f "$tmp_dir/home/.fake-mise-doctor-warn"

check_mise_doctor_body="$(
  awk '
    /^check_mise_doctor\(\)/ { in_fn = 1 }
    in_fn { print }
    in_fn && /^}/ { exit }
  ' "$repo_root/scripts/verify/bootstrap.sh"
)"
[ -n "$check_mise_doctor_body" ] || fail "could not extract check_mise_doctor from bootstrap.sh"
printf '%s\n' "$check_mise_doctor_body" | grep -Fq 'dotfiles_run_clean_zsh' \
  || fail "bootstrap check_mise_doctor must probe via dotfiles_run_clean_zsh"
printf '%s\n' "$check_mise_doctor_body" | grep -Fq 'mise doctor' \
  || fail "bootstrap check_mise_doctor must run mise doctor"
printf '%s\n' "$check_mise_doctor_body" | grep -Fq 'print -l' \
  || fail "bootstrap check_mise_doctor must dump PATH on failure"
if printf '%s\n' "$check_mise_doctor_body" \
  | grep -vE '^[[:space:]]*#' \
  | grep -nE '(^|[^_[:alnum:]])(/bin/|/usr/|/opt/)?zsh([[:space:]"'\'']|$)' \
  | grep -Ev 'dotfiles_run_clean_zsh|dotfiles_probe_zsh' >/dev/null; then
  fail "bootstrap check_mise_doctor still invokes bare zsh"
fi

# Inherited mise session + fat PATH must not reach the probe. Scope the poisoned
# PATH to probe invocations so the rest of the fixture keeps the real PATH.
caller_mise_path="/Users/fixture/.local/share/mise/installs/node/24.18.0/bin:/opt/homebrew/bin:/usr/bin:/bin"
export MISE_SHELL=zsh
export __MISE_SESSION=session-token
export __MISE_ORIG_PATH="/opt/homebrew/bin:/usr/bin:/bin"
export __MISE_ZSH_ACTIVATE_PATH="/Users/fixture/.local/share/mise/installs/node/24.18.0/bin:/opt/homebrew/bin"

HOME="$tmp_dir/home" \
  DOTFILES_ZSH_BIN="$tmp_dir/bin/zsh" \
  ZDOTDIR="$tmp_dir/zdot" \
  XDG_CONFIG_HOME="$tmp_dir/xdg-config" \
  MISE_CONFIG_DIR="$tmp_dir/mise-config" \
  PATH="$caller_mise_path" \
  dotfiles_run_clean_zsh -lic 'mise doctor' >/dev/null

grep -Fxq "flags=-lic mise doctor" "$probe_log" || fail "clean zsh probe did not keep shell flags"
grep -Fxq "zdotdir=$tmp_dir/zdot" "$probe_log" || fail "clean zsh probe dropped ZDOTDIR"
grep -Fxq "xdg_config=$tmp_dir/xdg-config" "$probe_log" || fail "clean zsh probe dropped XDG_CONFIG_HOME"
grep -Fxq "mise_config=$tmp_dir/mise-config" "$probe_log" || fail "clean zsh probe dropped MISE_CONFIG_DIR"
grep -Fxq "mise_shell=" "$probe_log" || fail "clean zsh probe leaked MISE_SHELL"
grep -Fxq "mise_session=" "$probe_log" || fail "clean zsh probe leaked __MISE_SESSION"
grep -Fxq "mise_orig_path=" "$probe_log" || fail "clean zsh probe leaked __MISE_ORIG_PATH"
grep -Fxq "mise_activate_path=" "$probe_log" || fail "clean zsh probe leaked __MISE_ZSH_ACTIVATE_PATH"
grep -q '/Users/fixture/.local/share/mise' "$probe_log" \
  && fail "clean zsh probe leaked the caller mise PATH"
observed_path="$(sed -n 's/^path=//p' "$probe_log" | head -n 1)"
[ -n "$observed_path" ] || fail "clean zsh probe did not record PATH"
case "$observed_path" in
  *:/usr/bin:/bin:/usr/sbin:/sbin|/usr/bin:/bin:/usr/sbin:/sbin) ;;
  *) fail "clean zsh probe seed PATH missing system suffix: $observed_path" ;;
esac
case "$observed_path" in
  /opt/homebrew/bin:/opt/homebrew/sbin:*|/usr/local/bin:/usr/local/sbin:*|/usr/bin:/bin:/usr/sbin:/sbin) ;;
  *) fail "clean zsh probe seed PATH missing expected Homebrew/system prefix: $observed_path" ;;
esac

check_mise_doctor() {
  local label="$1"
  local shell_flags="$2"
  local output

  output="$(
    PATH="$caller_mise_path" \
      dotfiles_run_clean_zsh "$shell_flags" 'mise doctor' 2>&1
  )"
  if grep -q 'tool paths are not first in PATH' <<< "$output"; then
    printf '\n## PATH (%s)\n' "$label" >&2
    # shellcheck disable=SC2016 # zsh code evaluated by the probe shell
    PATH="$caller_mise_path" \
      dotfiles_run_clean_zsh "$shell_flags" 'print -l ${(s/:/)PATH} | nl -ba | sed -n "1,60p"' >&2
    printf 'FAILED: mise tool paths are not first in PATH (%s)\n' "$label" >&2
    return 1
  fi
  return 0
}

: >"$probe_log"
: >"$tmp_dir/home/.fake-mise-doctor-warn"
set +e
warn_output="$(
  HOME="$tmp_dir/home" \
    DOTFILES_ZSH_BIN="$tmp_dir/bin/zsh" \
    check_mise_doctor "login interactive" -lic 2>&1
)"
warn_status=$?
set -e
[ "$warn_status" -ne 0 ] || fail "misordered target shell was accepted"
printf '%s\n' "$warn_output" | grep -Fq 'FAILED: mise tool paths are not first in PATH (login interactive)' \
  || fail "misordered target shell did not report the labeled failure"
printf '%s\n' "$warn_output" | grep -Fq '## PATH (login interactive)' \
  || fail "misordered target shell did not print its effective PATH"

: >"$probe_log"
rm -f "$tmp_dir/home/.fake-mise-doctor-warn"
HOME="$tmp_dir/home" \
  DOTFILES_ZSH_BIN="$tmp_dir/bin/zsh" \
  check_mise_doctor "interactive" -ic >/dev/null \
  || fail "healthy target shell was rejected"

printf 'ok mise PATH probes are isolated from an activated caller shell\n'
