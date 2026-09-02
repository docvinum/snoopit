#!/usr/bin/env bash
#
# Restores a Chrome profile from a backup.
#
# The current profile is moved aside rather than deleted: if the archive turns out to
# be the wrong one, the sessions are still recoverable.
#
# Usage:  sudo ./deploy/restore-profile.sh <archive.tar.zst>

set -euo pipefail

STATE_DIR="${SNOOPIT_STATE_DIR:-/var/lib/snoopit}"
PROFILE="$STATE_DIR/chrome-profile"
ARCHIVE="${1:-}"

[[ -n "$ARCHIVE" && -f "$ARCHIVE" ]] || { echo "Usage: $0 <archive>" >&2; exit 2; }

DECOMPRESS=(zstd -dc)
case "$ARCHIVE" in
  *.gz) DECOMPRESS=(gzip -dc) ;;
esac

was_running=0
# stderr is silenced so the script stays quiet on a host without systemd.
if command -v systemctl >/dev/null && systemctl is-active --quiet snoopit-chrome.service 2>/dev/null; then
  was_running=1
  echo "==> Stopping Chrome"
  systemctl stop snoopit-chrome.service
fi

if [[ -d "$PROFILE" ]]; then
  ASIDE="$PROFILE.replaced-$(date -u +%Y-%m-%dT%H%M%SZ)"
  echo "==> Moving the current profile to $ASIDE"
  mv "$PROFILE" "$ASIDE"
fi

echo "==> Restoring from $ARCHIVE"
mkdir -p "$STATE_DIR"
"${DECOMPRESS[@]}" "$ARCHIVE" | tar -xf - -C "$STATE_DIR"

if id -u snoopit >/dev/null 2>&1; then
  chown -R snoopit:snoopit "$PROFILE"
fi

if [[ $was_running -eq 1 ]]; then
  echo "==> Restarting Chrome"
  systemctl start snoopit-chrome.service
fi
echo "==> Restored. The previous profile is kept alongside; remove it once verified."
