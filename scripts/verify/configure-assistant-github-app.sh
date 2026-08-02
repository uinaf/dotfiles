#!/usr/bin/env bash
set -euo pipefail

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
configurator="$repo_root/scripts/bootstrap/configure-assistant-github-app.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
real_git="$(command -v git)"

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

mkdir -p \
  "$tmp_dir/bin" \
  "$tmp_dir/home/.config/dotfiles" \
  "$tmp_dir/home/.config/gh/extensions/gh-app-auth/keys" \
  "$tmp_dir/home/.local/share/gh/extensions/gh-app-auth" \
  "$tmp_dir/repos/one" \
  "$tmp_dir/repos/two" \
  "$tmp_dir/repos/ssh"
chmod 0700 \
  "$tmp_dir/home/.config/dotfiles" \
  "$tmp_dir/home/.config/gh/extensions/gh-app-auth/keys"
printf 'assistant\n' >"$tmp_dir/home/.config/dotfiles/profile"
cat >"$tmp_dir/home/.gitconfig" <<'EOF'
[include]
	path = ~/.gitconfig.local
[include]
	path = ~/.config/dotfiles/github-app.gitconfig
EOF
cat >"$tmp_dir/home/.config/gh/extensions/gh-app-auth/keys/example-app.pem" <<'EOF'
-----BEGIN PRIVATE KEY-----
fixture
-----END PRIVATE KEY-----
EOF
chmod 0600 "$tmp_dir/home/.config/gh/extensions/gh-app-auth/keys/example-app.pem"
cat >"$tmp_dir/home/.local/share/gh/extensions/gh-app-auth/gh-app-auth" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod 0700 "$tmp_dir/home/.local/share/gh/extensions/gh-app-auth/gh-app-auth"

cat >"$tmp_dir/bin/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = -C ] && [ "${3:-}" = ls-remote ]; then
  printf 'git %s\n' "$*" >>"$FAKE_APP_LOG"
  exit 0
fi
exec "$REAL_GIT" "$@"
EOF

cat >"$tmp_dir/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'gh %s\n' "$*" >>"$FAKE_APP_LOG"
case "${1:-} ${2:-}" in
  'auth status') [ "${FAKE_HUMAN_AUTH:-0}" = 1 ] ;;
  'app-auth setup') exit 0 ;;
  'app-auth list')
    printf 'NAME\tAPP ID\tINSTALLATION ID\tPATTERNS\tPRIORITY\tKEY SOURCE\n'
    printf 'example-app\t123\t456\tgithub.com/example/one, github.com/example/two\t5\tfixture\n'
    ;;
  'app-auth test') exit 0 ;;
  'app-auth exec')
    while [ "$#" -gt 0 ]; do
      if [ "$1" = api ]; then
        shift
        printf '%s\n' "${1#repos/}"
        exit 0
      fi
      shift
    done
    exit 64
    ;;
  *) exit 64 ;;
esac
EOF
chmod 0700 "$tmp_dir/bin/git" "$tmp_dir/bin/gh"

for repo in one two ssh; do
  "$real_git" -C "$tmp_dir/repos/$repo" init -q
done
"$real_git" -C "$tmp_dir/repos/one" remote add origin https://github.com/example/one.git
"$real_git" -C "$tmp_dir/repos/two" remote add origin https://github.com/example/two.git
"$real_git" -C "$tmp_dir/repos/ssh" remote add origin git@github.com:example/ssh.git

log="$tmp_dir/app.log"
: >"$log"
HOME="$tmp_dir/home" \
PATH="$tmp_dir/bin:/usr/bin:/bin" \
REAL_GIT="$real_git" \
FAKE_APP_LOG="$log" \
  "$configurator" \
    --name example-app \
    --app-id 123 \
    --installation-id 456 \
    --repo "$tmp_dir/repos/one" \
    --repo "$tmp_dir/repos/two" >/dev/null

git_include="$tmp_dir/home/.config/dotfiles/github-app.gitconfig"
[ -f "$git_include" ] || fail "configurator did not write the assistant Git include"
[ "$(stat -f '%Lp' "$git_include" 2>/dev/null || stat -c '%a' "$git_include")" = 600 ] \
  || fail "assistant Git include is not mode 0600"
[ "$("$real_git" config --file "$git_include" --get credential.https://github.com.useHttpPath)" = true ] \
  || fail "assistant Git include did not enable path-aware credentials"
[ "$("$real_git" config --file "$git_include" --get-all credential.https://github.com.helper | wc -l | tr -d ' ')" = 2 ] \
  || fail "assistant Git include did not reset and install exactly one helper"
[ "$("$real_git" config --file "$git_include" --get-all credential.https://github.com.helper | tail -1)" = \
  "!$tmp_dir/home/.local/share/gh/extensions/gh-app-auth/gh-app-auth git-credential" ] \
  || fail "assistant Git include did not call the installed gh-app-auth helper directly"
grep -Fq \
  "gh app-auth setup --app-id 123 --installation-id 456 --key-file $tmp_dir/home/.config/gh/extensions/gh-app-auth/keys/example-app.pem --patterns github.com/example/one,github.com/example/two --name example-app --use-filesystem" \
  "$log" || fail "configurator did not provision the exact App and repository set"
grep -Fq "gh app-auth exec --repo github.com/example/one -- gh api repos/example/one --jq .full_name" "$log" \
  || fail "configurator did not verify repository API access"
grep -Fq "ls-remote origin HEAD" "$log" \
  || fail "configurator did not verify Git credential access"

before="$(shasum -a 256 "$git_include" | awk '{ print $1 }')"
HOME="$tmp_dir/home" \
PATH="$tmp_dir/bin:/usr/bin:/bin" \
REAL_GIT="$real_git" \
FAKE_APP_LOG="$log" \
  "$configurator" --check \
    --name example-app \
    --app-id 123 \
    --installation-id 456 \
    --repo "$tmp_dir/repos/one" \
    --repo github.com/example/two >/dev/null
after="$(shasum -a 256 "$git_include" | awk '{ print $1 }')"
[ "$before" = "$after" ] || fail "check mode mutated the assistant Git include"

set +e
output="$(
  HOME="$tmp_dir/home" \
  PATH="$tmp_dir/bin:/usr/bin:/bin" \
  REAL_GIT="$real_git" \
  FAKE_APP_LOG="$log" \
  FAKE_HUMAN_AUTH=1 \
    "$configurator" --check \
      --name example-app --app-id 123 --installation-id 456 \
      --repo "$tmp_dir/repos/one" \
      --repo github.com/example/two 2>&1
)"
status=$?
set -e
[ "$status" -eq 1 ] || fail "human gh login returned $status instead of 1"
printf '%s\n' "$output" | grep -Fq 'a human gh auth login exists' \
  || fail "human gh login did not return an actionable identity failure"

chmod 0644 "$tmp_dir/home/.config/gh/extensions/gh-app-auth/keys/example-app.pem"
set +e
output="$(
  HOME="$tmp_dir/home" \
  PATH="$tmp_dir/bin:/usr/bin:/bin" \
  REAL_GIT="$real_git" \
  FAKE_APP_LOG="$log" \
    "$configurator" \
      --name example-app --app-id 123 --installation-id 456 \
      --repo "$tmp_dir/repos/one" 2>&1
)"
status=$?
set -e
[ "$status" -eq 1 ] || fail "unsafe private-key mode returned $status instead of 1"
printf '%s\n' "$output" | grep -Fq 'permissions must be owner-only' \
  || fail "unsafe private-key mode did not return an actionable failure"
chmod 0600 "$tmp_dir/home/.config/gh/extensions/gh-app-auth/keys/example-app.pem"

set +e
output="$(
  HOME="$tmp_dir/home" \
  PATH="$tmp_dir/bin:/usr/bin:/bin" \
  REAL_GIT="$real_git" \
  FAKE_APP_LOG="$log" \
    "$configurator" \
      --name example-app --app-id 123 --installation-id 456 \
      --repo "$tmp_dir/repos/ssh" 2>&1
)"
status=$?
set -e
[ "$status" -eq 1 ] || fail "SSH origin returned $status instead of 1"
printf '%s\n' "$output" | grep -Fq 'must use an HTTPS github.com origin' \
  || fail "SSH origin did not return an actionable migration failure"

printf 'ok assistant GitHub App configuration is global, exact-scope, idempotent, and fail-closed\n'
