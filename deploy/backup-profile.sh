#!/usr/bin/env bash
#
# Backs up the Chrome profile — the authenticated sessions that make this system
# useful, and the one piece of state that cannot be rebuilt from the database.
#
# Chrome is stopped for the copy. A profile snapshot taken while Chrome is writing to
# its LevelDB stores can restore into a corrupt profile, which is worse than no
# backup: it fails later, silently, and nobody connects it to the backup.
#
# Usage:  sudo ./deploy/backup-profile.sh [destination-dir]

set -euo pipefail

STATE_DIR="${SNOOPIT_STATE_DIR:-/var/lib/snoopit}"
PROFILE="$STATE_DIR/chrome-profile"
DEST="${1:-$STATE_DIR/backups}"
STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
ARCHIVE="$DEST/chrome-profile-$STAMP.tar.zst"

[[ -d "$PROFILE" ]] || { echo "No profile at $PROFILE" >&2; exit 1; }
mkdir -p "$DEST"

COMPRESS=(zstd -q)
command -v zstd >/dev/null || { COMPRESS=(gzip); ARCHIVE="${ARCHIVE%.zst}.gz"; }

was_running=0
# stderr is silenced so the script stays quiet on a host without systemd.
if command -v systemctl >/dev/null && systemctl is-active --quiet snoopit-chrome.service 2>/dev/null; then
  was_running=1
  echo "==> Stopping Chrome for a consistent copy"
  systemctl stop snoopit-chrome.service
fi

# Restart Chrome whatever happens, including on a failed copy.
restore_service() {
  if [[ $was_running -eq 1 ]]; then
    echo "==> Restarting Chrome"
    systemctl start snoopit-chrome.service
  fi
}
trap restore_service EXIT

echo "==> Archiving $PROFILE"
# Caches are large, churn constantly, and are rebuilt on demand. Cookies and
# Local Storage — the part that matters — are kept.
tar --exclude='*/Cache/*' \
    --exclude='*/Code Cache/*' \
    --exclude='*/GPUCache/*' \
    --exclude='*/ShaderCache/*' \
    --exclude='*/Service Worker/CacheStorage/*' \
    -cf - -C "$(dirname "$PROFILE")" "$(basename "$PROFILE")" \
  | "${COMPRESS[@]}" > "$ARCHIVE"

echo "==> Wrote $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"

# Keep the last 7. A backup policy nobody prunes fills the disk and takes the
# crawler down with it.
ls -1t "$DEST"/chrome-profile-*.tar.* 2>/dev/null | tail -n +8 | while read -r old; do
  echo "==> Pruning $old"
  rm -f "$old"
done
