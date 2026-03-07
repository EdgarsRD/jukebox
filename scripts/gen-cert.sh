#!/bin/bash
# gen-cert.sh — generates a self-signed TLS cert for jukebox.kzd
#
# Run once during initial setup from the project root:
#   bash scripts/gen-cert.sh
#
# The cert covers:
#   - jukebox.kzd  (the local domain patrons use)
#   - localhost / 127.0.0.1
#   - your machine's detected local IP (fallback if DNS not set up yet)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

CERT="$PROJECT_DIR/cert.pem"
KEY="$PROJECT_DIR/key.pem"

echo "→ Detecting local IP address..."
LOCAL_IP=$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || hostname -I | awk '{print $1}')

if [ -z "$LOCAL_IP" ]; then
  echo "  Could not auto-detect IP. Enter it manually (e.g. 192.168.1.50):"
  read -r LOCAL_IP
fi

echo "  Local IP : $LOCAL_IP"
echo "  Domain   : jukebox.kzd"

SAN="subjectAltName=DNS:jukebox.kzd,DNS:localhost,IP:127.0.0.1,IP:$LOCAL_IP"

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$KEY" \
  -out "$CERT" \
  -days 3650 \
  -subj "/CN=jukebox.kzd/O=Jukebox/C=LV" \
  -addext "$SAN"

echo ""
echo "✅  Certificate generated (valid 10 years)"
echo "    cert.pem → $CERT"
echo "    key.pem  → $KEY"
echo "    Covers   : jukebox.kzd, localhost, 127.0.0.1, $LOCAL_IP"
echo ""
echo "Next steps:"
echo "  1. Set a static local IP on this machine: $LOCAL_IP"
echo "  2. Add DNS entry on your router: jukebox.kzd → $LOCAL_IP"
echo "  3. Start the server: npm start"
echo "  4. Open https://jukebox.kzd:3000/admin to complete setup"
echo ""
echo "Patrons will see a one-time 'Not Secure' warning."
echo "They tap Advanced → Proceed. Never see it again on that device."
