#!/bin/bash
# Copilot PM Agent — Install / Reinstall Script (macOS & Linux)
# Usage: bash install.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Read version from package.json
if [ -f "$SCRIPT_DIR/package.json" ]; then
  VERSION=$(node -p "require('$SCRIPT_DIR/package.json').version" 2>/dev/null || echo "")
fi

# Find the VSIX — try versioned name first, then glob
VSIX=""
if [ -n "$VERSION" ] && [ -f "$SCRIPT_DIR/copilot-pm-agent-${VERSION}.vsix" ]; then
  VSIX="$SCRIPT_DIR/copilot-pm-agent-${VERSION}.vsix"
else
  VSIX=$(ls "$SCRIPT_DIR"/copilot-pm-agent-*.vsix 2>/dev/null | head -1)
fi

echo "Copilot PM Agent — Installer"
echo "=============================="
[ -n "$VERSION" ] && echo "Version: $VERSION"

# Detect platform
if [[ "$OSTYPE" == "darwin"* ]]; then
  SUPPORT_DIR="$HOME/Library/Application Support/Code"
  CACHE_DIR="$HOME/Library/Caches/com.microsoft.VSCode"
elif [[ "$OSTYPE" == "linux"* ]]; then
  SUPPORT_DIR="$HOME/.config/Code"
  CACHE_DIR=""
else
  echo "Unsupported OS: $OSTYPE — use install.bat for Windows."
  exit 1
fi

EXT_DIR="$HOME/.vscode/extensions"

if [ -z "$VSIX" ] || [ ! -f "$VSIX" ]; then
  echo "Error: No .vsix file found in $SCRIPT_DIR"
  exit 1
fi

if ! command -v code &>/dev/null; then
  echo "Error: 'code' command not found."
  echo "Open VS Code → Cmd+Shift+P → 'Shell Command: Install code command in PATH'"
  exit 1
fi

echo ""
echo "[1/5] Closing VS Code..."
if [[ "$OSTYPE" == "darwin"* ]]; then
  osascript -e 'quit app "Visual Studio Code"' 2>/dev/null || true
fi
pkill -f "Visual Studio Code" 2>/dev/null || true
sleep 2

echo "[2/5] Removing previous versions..."
removed=0
for d in "$EXT_DIR"/*pm-agent* "$EXT_DIR"/*copilot-pm-agent*; do
  if [ -d "$d" ]; then rm -rf "$d"; removed=$((removed + 1)); fi
done
echo "  Removed $removed previous installation(s)"

echo "[3/5] Clearing stale caches..."
for dir in "$SUPPORT_DIR/Service Worker" "$SUPPORT_DIR/Webview" "$SUPPORT_DIR/CachedExtensions" "$SUPPORT_DIR/logs"; do
  [ -d "$dir" ] && rm -rf "$dir"
done
[ -n "$CACHE_DIR" ] && [ -d "$CACHE_DIR" ] && rm -rf "$CACHE_DIR"

STATE_DB="$SUPPORT_DIR/User/globalStorage/state.vscdb"
if [ -f "$STATE_DB" ] && command -v sqlite3 &>/dev/null; then
  sqlite3 "$STATE_DB" "DELETE FROM ItemTable WHERE key LIKE '%pm-agent%' OR key LIKE '%pmAgent%';" 2>/dev/null || true
fi

echo "[4/5] Installing $(basename "$VSIX")..."
code --install-extension "$VSIX" --force 2>&1

echo "[5/5] Verifying..."
installed=$(find "$EXT_DIR" -maxdepth 1 -name "*pm-agent*" -type d 2>/dev/null | wc -l | tr -d ' ')
if [ "$installed" -eq 1 ]; then
  echo ""
  echo "=============================="
  echo "Installed successfully."
  echo "Open VS Code to get started."
  echo "=============================="
else
  echo "Installation may need manual verification."
fi
