#!/usr/bin/env bash
set -euo pipefail

state_path="${CHROME_LOCAL_STATE:-$HOME/Library/Application Support/Google/Chrome/Local State}"
flag_name="vertical-tabs"
flag_value="vertical-tabs@1"
mode="enable"
allow_running=0

usage() {
  cat <<'USAGE'
Usage:
  scripts/bootstrap/configure-chrome.sh [options]

Enables Chrome's native vertical tabs flag in the local Chrome "Local State"
file. Quit Chrome before running this script so Chrome does not overwrite the
change on exit.

Options:
  --state PATH       Chrome Local State path
  --disable          remove the vertical-tabs flag
  --allow-running    write even when Chrome appears to be running
  -h, --help

After enabling, relaunch Chrome and move tabs to the side from Chrome's tab bar
context menu or Settings > Appearance when the option is available.
USAGE
}

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

chrome_is_running() {
  pgrep -x "Google Chrome" >/dev/null 2>&1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --state)
      shift
      [ "$#" -gt 0 ] || fail "--state requires a value"
      state_path="$1"
      ;;
    --disable)
      mode="disable"
      ;;
    --allow-running)
      allow_running=1
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

if [ "$allow_running" -eq 0 ] && chrome_is_running; then
  fail "quit Google Chrome before changing Local State, or rerun with --allow-running"
fi

mkdir -p "$(dirname "$state_path")"

python3 - "$state_path" "$mode" "$flag_name" "$flag_value" <<'PY'
import json
import os
import stat
import sys
import tempfile

path, mode, flag_name, flag_value = sys.argv[1:]

try:
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
except FileNotFoundError:
    data = {}
except json.JSONDecodeError as exc:
    raise SystemExit(f"FAILED: {path} is not valid JSON: {exc}") from exc

if not isinstance(data, dict):
    raise SystemExit(f"FAILED: {path} must contain a JSON object")

browser = data.setdefault("browser", {})
if not isinstance(browser, dict):
    raise SystemExit('FAILED: "browser" must be a JSON object')

experiments = browser.get("enabled_labs_experiments", [])
if experiments is None:
    experiments = []
if not isinstance(experiments, list):
    raise SystemExit('FAILED: "browser.enabled_labs_experiments" must be a JSON array')

prefix = f"{flag_name}@"
experiments = [
    item for item in experiments
    if not (isinstance(item, str) and (item == flag_name or item.startswith(prefix)))
]

if mode == "enable":
    experiments.append(flag_value)
elif mode != "disable":
    raise SystemExit(f"FAILED: unknown mode: {mode}")

browser["enabled_labs_experiments"] = experiments

directory = os.path.dirname(path) or "."
try:
    existing_mode = stat.S_IMODE(os.stat(path).st_mode)
except FileNotFoundError:
    existing_mode = 0o600

fd, tmp_path = tempfile.mkstemp(prefix=".Local State.", dir=directory)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")
    os.chmod(tmp_path, existing_mode)
    os.replace(tmp_path, path)
finally:
    try:
        os.unlink(tmp_path)
    except FileNotFoundError:
        pass
PY

if [ "$mode" = "enable" ]; then
  printf 'enabled Chrome flag: %s in %s\n' "$flag_value" "$state_path"
else
  printf 'disabled Chrome flag: %s in %s\n' "$flag_name" "$state_path"
fi
