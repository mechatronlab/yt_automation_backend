#!/usr/bin/env bash
# Download a user profile from OpenVPN Access Server (e.g. meclayt.openvpn.com)
#
# Usage:
#   export OPENVPN_SERVER="https://meclayt.openvpn.com"
#   export OPENVPN_USER="your_username"
#   export OPENVPN_PASS="your_password"
#   ./scripts/download-profile.sh
#
# Writes: ./client.ovpn

set -euo pipefail

SERVER="${OPENVPN_SERVER:-https://meclayt.openvpn.com}"
USER="${OPENVPN_USER:?Set OPENVPN_USER}"
PASS="${OPENVPN_PASS:?Set OPENVPN_PASS}"
OUT="${OPENVPN_OUT:-./client.ovpn}"

# Strip trailing slash
SERVER="${SERVER%/}"

URL="${SERVER}/rest/GetUserlogin?use_defaults=1"

echo "Downloading profile from ${SERVER} ..."
curl -fsSL -k -u "${USER}:${PASS}" "${URL}" -o "${OUT}"

if [[ ! -s "${OUT}" ]] || grep -qi '<html' "${OUT}"; then
  echo "Download failed or returned HTML instead of a profile." >&2
  echo "Try downloading manually in a browser (see README)." >&2
  rm -f "${OUT}"
  exit 1
fi

echo "Saved: ${OUT}"
echo "Run: npm run connect"
