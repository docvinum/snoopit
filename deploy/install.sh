#!/usr/bin/env bash
#
# Installs snoopit on a Debian/Ubuntu host (the OptiPlex target).
#
# Idempotent: safe to re-run to upgrade. It never touches the Chrome profile or the
# database, which are the two things that must survive a deployment.
#
# Usage:  sudo ./deploy/install.sh [--user snoopit] [--prefix /opt/snoopit]

set -euo pipefail

SERVICE_USER="snoopit"
PREFIX="/opt/snoopit"
STATE_DIR="/var/lib/snoopit"
CONFIG_DIR="/etc/snoopit"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)   SERVICE_USER="$2"; shift 2 ;;
    --prefix) PREFIX="$2";       shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "This script must run as root (it creates a system user and installs units)." >&2
  exit 1
fi

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }

# ── Prerequisites ────────────────────────────────────────────────────────────
command -v node >/dev/null || { echo "node is required (>= 22)" >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 22 ]] || { echo "node >= 22 is required, found $NODE_MAJOR" >&2; exit 1; }

CHROME_BIN="$(command -v google-chrome-stable || command -v google-chrome || command -v chromium || true)"
[[ -n "$CHROME_BIN" ]] || { echo "Chrome or Chromium is required" >&2; exit 1; }
say "Using Chrome at $CHROME_BIN"

XVFB_RUN_BIN="$(command -v xvfb-run || true)"
[[ -n "$XVFB_RUN_BIN" ]] || { echo "xvfb-run is required for the persistent Chrome display" >&2; exit 1; }
say "Using Xvfb at $XVFB_RUN_BIN"

# ── Service user and directories ─────────────────────────────────────────────
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  say "Creating system user $SERVICE_USER"
  useradd --system --home-dir "$STATE_DIR" --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$STATE_DIR" "$STATE_DIR/chrome-profile" "$STATE_DIR/data"
install -d -m 0755 "$CONFIG_DIR" "$PREFIX"

# ── Application ──────────────────────────────────────────────────────────────
say "Building"
( cd "$REPO_ROOT" && npm ci --omit=dev --ignore-scripts >/dev/null && npm ci >/dev/null && npm run build >/dev/null )

say "Installing to $PREFIX"
rm -rf "$PREFIX/dist" "$PREFIX/node_modules"
cp -r "$REPO_ROOT/dist" "$REPO_ROOT/node_modules" "$REPO_ROOT/package.json" "$PREFIX/"
cp -r "$REPO_ROOT/profiles" "$PREFIX/" 2>/dev/null || true
chown -R root:root "$PREFIX"

# ── Configuration ────────────────────────────────────────────────────────────
# Never overwritten: an upgrade must not silently change how the crawler behaves.
if [[ ! -f "$CONFIG_DIR/snoopit.config.yaml" ]]; then
  say "Writing default configuration"
  cat > "$CONFIG_DIR/snoopit.config.yaml" <<YAML
dataDir: $STATE_DIR/data

browser:
  # Loopback only. This port grants full control of an authenticated browser.
  cdpUrl: http://127.0.0.1:9222

llm:
  # Recovery stops at L1 when no key is set, which is a supported configuration.
  provider: openrouter
  baseUrl: https://openrouter.ai/api/v1
  model: anthropic/claude-sonnet-4.6
  apiKeyEnv: SNOOPIT_LLM_API_KEY
YAML
  chown root:"$SERVICE_USER" "$CONFIG_DIR/snoopit.config.yaml"
  chmod 0640 "$CONFIG_DIR/snoopit.config.yaml"
fi

if [[ ! -f "$CONFIG_DIR/snoopit.env" ]]; then
  say "Writing empty secrets file"
  printf '# Secrets for snoopit. Readable only by the service user.\n#SNOOPIT_LLM_API_KEY=\n' \
    > "$CONFIG_DIR/snoopit.env"
  chown root:"$SERVICE_USER" "$CONFIG_DIR/snoopit.env"
  chmod 0640 "$CONFIG_DIR/snoopit.env"
fi

# ── systemd ──────────────────────────────────────────────────────────────────
say "Installing systemd units"
for unit in snoopit-chrome.service snoopit-tick.service snoopit-tick.timer; do
  sed -e "s#/opt/snoopit#$PREFIX#g" \
      -e "s#/usr/bin/google-chrome-stable#$CHROME_BIN#g" \
      -e "s#/usr/bin/xvfb-run#$XVFB_RUN_BIN#g" \
      -e "s#^User=snoopit#User=$SERVICE_USER#" \
      -e "s#^Group=snoopit#Group=$SERVICE_USER#" \
      "$REPO_ROOT/deploy/systemd/$unit" > "/etc/systemd/system/$unit"
done
systemctl daemon-reload

say "Applying database migrations"
sudo -u "$SERVICE_USER" node "$PREFIX/dist/src/cli/main.js" migrate --config "$CONFIG_DIR/snoopit.config.yaml"

say "Starting services"
systemctl enable --now snoopit-chrome.service
systemctl enable --now snoopit-tick.timer

say "Done. Check with:"
echo "  sudo -u $SERVICE_USER node $PREFIX/dist/src/cli/main.js doctor --config $CONFIG_DIR/snoopit.config.yaml"
