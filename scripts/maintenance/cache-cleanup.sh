#!/bin/sh
# Reclaim aged developer caches for the current user.
# Never touches project sources, simulator runtimes, or other users' homes.
set -u
failed=0
cd "$HOME" || exit 1

dry_run=0
for argument in "$@"; do
  case "$argument" in
    --dry-run) dry_run=1 ;;
    -h|--help)
      echo "Usage: disk-cleanup [--dry-run]"
      exit 0
      ;;
    *)
      echo "unknown argument: $argument" >&2
      exit 2
      ;;
  esac
done

data_volume="/System/Volumes/Data"
[ -d "$data_volume" ] || data_volume="/"

used_kb() {
  df -k "$data_volume" | awk 'NR == 2 { print $3 }'
}

log() {
  printf '%s disk-cleanup %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

run() {
  if [ "$dry_run" -eq 1 ]; then
    log "dry-run: $*"
    return 0
  fi
  if ! "$@" >/dev/null 2>&1; then
    log "warning: failed: $1"
    failed=1
  fi
}

prune_old_files() {
  [ -d "$1" ] || return 0
  log "prune files older than $2 days under $1"
  if [ "$dry_run" -eq 1 ]; then
    find "$1" -type f -mtime "+$2" -print 2>/dev/null | wc -l | awk '{ print "  would remove " $1 " files" }'
  else
    find "$1" -type f -mtime "+$2" -delete 2>/dev/null || failed=1
    find "$1" -type d -empty -delete 2>/dev/null || failed=1
  fi
}

before=$(used_kb)
log "start used=$(awk "BEGIN { printf \"%.1fG\", $before / 1048576 }") dry_run=$dry_run"

prune_old_files "$HOME/Library/Developer/Xcode/DerivedData" 30
prune_old_files "$HOME/Library/Developer/CoreSimulator/Caches" 30
prune_old_files "$HOME/Library/Logs/CoreSimulator" 14
prune_old_files "$HOME/.gradle/caches/build-cache-1" 30
prune_old_files "$HOME/.gradle/daemon" 14
prune_old_files "$HOME/Library/Caches/go-build" 30
prune_old_files "$HOME/Library/Logs/DiagnosticReports" 30

if command -v xcrun >/dev/null 2>&1; then
  log "delete unavailable simulators"
  run xcrun simctl delete unavailable
fi
if command -v pnpm >/dev/null 2>&1; then
  log "pnpm store prune"
  run pnpm store prune
fi
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  log "docker build cache older than 7 days"
  run docker builder prune -f --filter until=168h
fi

after=$(used_kb)
log "done used=$(awk "BEGIN { printf \"%.1fG\", $after / 1048576 }") freed=$(awk "BEGIN { printf \"%.1fG\", ($before - $after) / 1048576 }")"

exit "$failed"
