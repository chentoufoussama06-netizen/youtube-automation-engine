#!/usr/bin/env bash
# Provisions a fresh Debian/Ubuntu VPS to run the content worker unattended.
# Idempotent: safe to re-run after a git pull.
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/youtube-automation-agent}
APP_USER=${APP_USER:-youtube}
REPO=${REPO:-https://github.com/darkzOGx/youtube-automation-agent.git}
BRANCH=${BRANCH:-fix/french-narration-and-voice}

echo "==> Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# ffmpeg from the distro is used in preference to the bundled ffmpeg-static
# binary, which is a Windows/glibc build and slower than the native package.
apt-get install -y -qq curl git ffmpeg ca-certificates python3 build-essential

if ! command -v node >/dev/null 2>&1; then
  echo "==> Installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
echo "    node $(node -v), ffmpeg $(ffmpeg -version | head -1 | awk '{print $3}')"

if ! id "$APP_USER" >/dev/null 2>&1; then
  echo "==> Creating service user '$APP_USER'"
  useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
fi

echo "==> Fetching application into $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --all --quiet
  git -C "$APP_DIR" checkout "$BRANCH" --quiet
  git -C "$APP_DIR" pull --quiet
else
  git clone --quiet --branch "$BRANCH" "$REPO" "$APP_DIR"
fi

mkdir -p "$APP_DIR"/{logs,data,temp,uploads}
cd "$APP_DIR"

echo "==> Installing dependencies"
npm ci --omit=dev --silent 2>/dev/null || npm install --omit=dev --silent

if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  echo ""
  echo "!! $APP_DIR/.env was created from the example and has NO API keys."
  echo "!! Add MISTRAL_API_KEY and PEXELS_API_KEY, then re-run this script."
  echo ""
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$APP_DIR/.env"

echo "==> Seeding the topic queue"
sudo -u "$APP_USER" node scripts/maintenance/seed-queue.js || true

echo "==> Installing systemd service"
install -m 644 "$APP_DIR/scripts/youtube-agent.service" /etc/systemd/system/youtube-agent.service
systemctl daemon-reload
systemctl enable --now youtube-agent.service

echo ""
echo "==> Done. The worker is running and will restart on reboot."
echo "    status:  systemctl status youtube-agent"
echo "    logs:    journalctl -u youtube-agent -f"
echo "    queue:   cat $APP_DIR/data/queue.json | head -40"
echo "    stop:    systemctl stop youtube-agent"
