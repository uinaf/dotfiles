#!/usr/bin/env bash
set -euo pipefail

source_commit="${GH_APP_AUTH_SOURCE_COMMIT:-620f73d8e27a81ea5736acbf5643b461da61c0f4}"
source_url="${GH_APP_AUTH_SOURCE_URL:-https://codeload.github.com/AmadeusITGroup/gh-app-auth/tar.gz/$source_commit}"
source_sha256="${GH_APP_AUTH_SOURCE_SHA256:-c4d80ff42526308bd27fc8b458e2c256bfced14cf6d90c4ce28afa3aa5ccbae3}"
go_version="${GH_APP_AUTH_GO_VERSION:-1.26.5}"
canonical_install_dir="$HOME/.local/share/gh/extensions/gh-app-auth"
install_dir="${GH_APP_AUTH_INSTALL_DIR:-$canonical_install_dir}"
binary="$install_dir/gh-app-auth"
marker="$install_dir/.dotfiles-source"

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

expected_marker="$({
  printf 'commit=%s\n' "$source_commit"
  printf 'source_sha256=%s\n' "$source_sha256"
  printf 'go=%s\n' "$go_version"
})"

verify_install() {
  "$binary" exec --help >/dev/null || fail "installed gh-app-auth binary does not run"
  if [ "$install_dir" = "$canonical_install_dir" ]; then
    GH_NO_EXTENSION_UPDATE_NOTIFIER=1 gh app-auth exec --help >/dev/null \
      || fail "GitHub CLI cannot execute the gh-app-auth extension"
  fi
}

need_command gh
if [ -x "$binary" ] && [ -f "$marker" ] && [ "$(cat "$marker")" = "$expected_marker" ]; then
  verify_install
  printf 'ok gh-app-auth is already installed at %s\n' "$binary"
  exit 0
fi

for command_name in curl tar shasum mise install; do
  need_command "$command_name"
done

runtime_dir="$(mktemp -d "${TMPDIR:-/tmp}/gh-app-auth-install.XXXXXX")"
cleanup() {
  chmod -R u+w "$runtime_dir" 2>/dev/null || true
  rm -rf "$runtime_dir"
}
trap cleanup EXIT HUP INT TERM

archive="$runtime_dir/source.tar.gz"
source_dir="$runtime_dir/source"
built_binary="$runtime_dir/gh-app-auth"
marker_file="$runtime_dir/source-marker"

printf 'fetching gh-app-auth source at %s\n' "$source_commit"
curl --fail --location --silent --show-error --retry 3 "$source_url" --output "$archive"
actual_sha256="$(shasum -a 256 "$archive" | awk '{print $1}')"
[ "$actual_sha256" = "$source_sha256" ] \
  || fail "gh-app-auth source checksum mismatch: expected $source_sha256, got $actual_sha256"

mkdir -p "$source_dir"
tar -xzf "$archive" -C "$source_dir" --strip-components=1

printf 'building gh-app-auth with temporary Go %s\n' "$go_version"
(
  cd "$source_dir"
  MISE_DATA_DIR="$runtime_dir/mise" \
  MISE_CACHE_DIR="$runtime_dir/mise-cache" \
  GOPATH="$runtime_dir/go" \
  GOCACHE="$runtime_dir/go-build" \
  GOMODCACHE="$runtime_dir/go/pkg/mod" \
    mise x --yes "go@$go_version" -- \
      go build -trimpath -buildvcs=false -ldflags='-s -w' -o "$built_binary" .
)

"$built_binary" exec --help >/dev/null || fail "built gh-app-auth binary does not run"
printf '%s\n' "$expected_marker" >"$marker_file"
chmod 0600 "$marker_file"

install -d -m 0700 "$install_dir"
install -m 0700 "$built_binary" "$binary.next"
install -m 0600 "$marker_file" "$marker.next"
mv "$binary.next" "$binary"
mv "$marker.next" "$marker"

verify_install
printf 'ok installed gh-app-auth at %s\n' "$binary"
