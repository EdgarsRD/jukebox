#!/bin/bash
# install-service.sh — installs jukebox as a systemd service on Ubuntu
# Run with sudo: sudo bash scripts/install-service.sh

set -e

if [ "$EUID" -ne 0 ]; then
  echo "❌  Please run with sudo: sudo bash scripts/install-service.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ACTUAL_USER="${SUDO_USER:-$(whoami)}"
NODE_PATH=$(su - "$ACTUAL_USER" -c "which node" 2>/dev/null || which node)

echo "→ Installing Jukebox as a systemd service"
echo "  Project dir : $PROJECT_DIR"
echo "  Running as  : $ACTUAL_USER"
echo "  Node binary  : $NODE_PATH"
echo ""

# Install npm dependencies as the actual user
echo "→ Installing npm dependencies..."
su - "$ACTUAL_USER" -c "cd '$PROJECT_DIR' && npm install --omit=dev"

# Write service file
SERVICE_FILE="/etc/systemd/system/jukebox.service"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Jukebox — Bar Song Request Queue
After=network.target

[Service]
Type=simple
User=$ACTUAL_USER
WorkingDirectory=$PROJECT_DIR
ExecStart=$NODE_PATH $PROJECT_DIR/server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=jukebox

# Allow binding to privileged ports if needed
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF

echo "✅  Service file written to $SERVICE_FILE"

# Reload, enable, start
systemctl daemon-reload
systemctl enable jukebox
systemctl start jukebox

echo ""
echo "✅  Jukebox service installed and started!"
echo ""
echo "  Useful commands:"
echo "  sudo systemctl status jukebox    — check status"
echo "  sudo systemctl restart jukebox   — restart after code changes"
echo "  sudo journalctl -u jukebox -f    — live logs"
echo "  sudo systemctl disable jukebox   — remove from autostart"
