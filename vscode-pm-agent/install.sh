#!/bin/bash
# PM Agent — Install / Reinstall Script (macOS & Linux)
# Usage: bash install.sh
#
# This script cleanly installs PM Agent by removing any previous versions,
# clearing stale caches, and installing the current VSIX.

set -e

VERSION="0.5.0"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VSIX="$SCRIPT_DIR/pm-agent-${VERSION}.vsix"

echo "PM Agent v${VERSION} — Installer"
echo "================================"

# ── Detect platform ──────────────────────────────────────────────────────
if [[ "$OSTYPE" == "darwin"* ]]; then
  SUPPORT_DIR="$HOME/Library/Application Support/Code"
  CACHE_DIR="$HOME/Library/Caches/com.microsoft.VSCode"
elif [[ "$OSTYPE" == "linux"* ]]; then
  SUPPORT_DIR="$HOME/.config/Code"
  CACHE_DIR=""
else
  echo "Unsupported OS: $OSTYPE"
  echo "Use install.bat for Windows."
  exit 1
fi

EXT_DIR="$HOME/.vscode/extensions"

# ── Check VSIX exists ───────────────────────────────────────────────────
if [ ! -f "$VSIX" ]; then
  echo "Error: $VSIX not found."
  echo "Place this script next to the .vsix file and run again."
  exit 1
fi

# ── Check code CLI ──────────────────────────────────────────────────────
if ! command -v code &>/dev/null; then
  echo "Error: 'code' command not found."
  echo "Open VS Code, then Cmd+Shift+P → 'Shell Command: Install code command in PATH'"
  exit 1
fi

# ── Close VS Code ───────────────────────────────────────────────────────
echo ""
echo "[1/5] Closing VS Code..."
if [[ "$OSTYPE" == "darwin"* ]]; then
  osascript -e 'quit app "Visual Studio Code"' 2>/dev/null || true
fi
pkill -f "Visual Studio Code" 2>/dev/null || true
sleep 2

# ── Remove previous versions ────────────────────────────────────────────
echo "[2/5] Removing previous PM Agent versions..."
removed=0
for d in "$EXT_DIR"/*pm-agent*; do
  if [ -d "$d" ]; then
    rm -rf "$d"
    removed=$((removed + 1))
  fi
done
echo "  Removed $removed previous installation(s)"

# ── Clear stale caches ──────────────────────────────────────────────────
echo "[3/5] Clearing stale caches..."
for dir in "$SUPPORT_DIR/Service Worker" "$SUPPORT_DIR/Webview" "$SUPPORT_DIR/CachedExtensions" "$SUPPORT_DIR/logs"; do
  if [ -d "$dir" ]; then
    rm -rf "$dir"
  fi
done
if [ -n "$CACHE_DIR" ] && [ -d "$CACHE_DIR" ]; then
  rm -rf "$CACHE_DIR"
fi

# Reset globalState for pm-agent
STATE_DB="$SUPPORT_DIR/User/globalStorage/state.vscdb"
if [ -f "$STATE_DB" ] && command -v sqlite3 &>/dev/null; then
  sqlite3 "$STATE_DB" "
    DELETE FROM ItemTable WHERE key LIKE '%pm-agent%';
    DELETE FROM ItemTable WHERE key LIKE '%pm.agent%';
    DELETE FROM ItemTable WHERE key LIKE '%pmAgent%';
  " 2>/dev/null || true
  echo "  Cleared extension state"
fi

# ── Install ──────────────────────────────────────────────────────────────
echo "[4/5] Installing PM Agent v${VERSION}..."
code --install-extension "$VSIX" --force 2>&1

# ── Verify ───────────────────────────────────────────────────────────────
echo "[5/5] Verifying..."
installed=$(find "$EXT_DIR" -maxdepth 1 -name "*pm-agent*" -type d 2>/dev/null | wc -l | tr -d ' ')
if [ "$installed" -eq 1 ]; then
  echo ""
  echo "================================"
  echo "PM Agent v${VERSION} installed successfully."
  echo ""
  echo "Open VS Code and you should see:"
  echo "  - PM Agent icon in the activity bar (sidebar)"
  echo "  - Welcome notification with 'Configure Platform' button"
  echo "================================"
elif [ "$installed" -gt 1 ]; then
  echo ""
  echo "Warning: Multiple PM Agent versions detected."
  echo "Run: code --uninstall-extension DataAlchemy.pm-agent"
  echo "Then run this script again."
else
  echo ""
  echo "Installation may have failed. Try manually:"
  echo "  code --install-extension $VSIX --force"
fi
