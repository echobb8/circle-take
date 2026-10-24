#!/usr/bin/env bash
# Circle Take macOS installer
#
# Downloads the latest release and installs it to /Applications, bypassing
# the Gatekeeper "app is damaged" false alarm that macOS shows for
# browser-downloaded unsigned apps (terminal downloads aren't quarantined).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/wassermanproductions/circle-take/main/install.sh | bash
set -euo pipefail

REPO="wassermanproductions/circle-take"
ASSET="CircleTake-mac-arm64.zip"

DEST="/Applications"
if [ ! -w "$DEST" ]; then
  DEST="$HOME/Applications"
  mkdir -p "$DEST"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading the latest Circle Take (Apple Silicon)..."
curl -fL --progress-bar "https://github.com/$REPO/releases/latest/download/$ASSET" -o "$TMP/$ASSET"

echo "Installing to $DEST..."
rm -rf "$DEST/Circle Take.app"
ditto -x -k "$TMP/$ASSET" "$DEST"
xattr -cr "$DEST/Circle Take.app" 2>/dev/null || true

echo "✓ Circle Take installed — launching."
open "$DEST/Circle Take.app"
