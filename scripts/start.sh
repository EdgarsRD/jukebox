#!/bin/bash
# start.sh — USB recovery script
#
# Plug USB into any spare Ubuntu/Debian machine, then:
#   bash start.sh
#
# This will:
#   1. Check Node.js is available
#   2. Install npm dependencies if missing
#   3. Optionally install as a systemd service (autostart on boot)
#   4. Start the server

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo ""
echo "  ╔══════════════════════════════╗"
echo "  ║      JUKEBOX  RECOVERY       ║"
echo "  ╚══════════════════════════════╝"
echo ""

# ── Node.js check ──
if ! command -v node &>/dev/null; then
  echo "❌  Node.js not found."
  echo "    Install it with:"
  echo "      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
  echo "      sudo apt install -y nodejs"
  exit 1
fi

NODE_VER=$(node -v)
echo "✅  Node.js $NODE_VER found"

# ── Dependencies ──
if [ ! -d "$PROJECT_DIR/node_modules" ]; then
  echo "→  Installing dependencies..."
  cd "$PROJECT_DIR" && npm install --omit=dev
else
  echo "✅  node_modules present"
fi

# ── Cert check ──
if [ ! -f "$PROJECT_DIR/cert.pem" ] || [ ! -f "$PROJECT_DIR/key.pem" ]; then
  echo ""
  echo "⚠️  No TLS certificate found."
  echo "    Generate one with: bash scripts/gen-cert.sh"
  echo "    The server will start in HTTP mode for now."
  echo ""
fi

# ── Config check ──
if [ ! -f "$PROJECT_DIR/config.json" ]; then
  echo "⚠️  No config.json found — server will create one on first run."
  echo "    Visit https://jukebox.kzd:3000/admin to complete setup."
fi

# ── Autostart option ──
echo ""
read -rp "Install as systemd service (autostart on boot)? [y/N] " INSTALL_SERVICE
if [[ "$INSTALL_SERVICE" =~ ^[Yy]$ ]]; then
  if [ "$EUID" -ne 0 ]; then
    echo "→  Re-running with sudo for service installation..."
    exec sudo bash "$SCRIPT_DIR/install-service.sh"
  else
    bash "$SCRIPT_DIR/install-service.sh"
  fi
else
  echo ""
  echo "→  Starting server manually (runs in foreground)..."
  echo "   Press Ctrl+C to stop."
  echo ""
  cd "$PROJECT_DIR" && node server.js
fi
