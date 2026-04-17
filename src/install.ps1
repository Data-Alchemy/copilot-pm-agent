# PM Agent — Install / Reinstall Script (Windows)
# Usage: .\install.ps1
#
# This script cleanly installs PM Agent by removing any previous versions,
# clearing stale caches, and installing the current VSIX.

$ErrorActionPreference = "Stop"

$Version = "0.5.0"
$Vsix = Join-Path $PSScriptRoot "pm-agent-$Version.vsix"

Write-Host "PM Agent v$Version — Installer"
Write-Host "================================"

# ── Check VSIX exists ──────────────────────────────────────────────────
if (-not (Test-Path $Vsix)) {
    Write-Host "Error: $Vsix not found."
    Write-Host "Place this script next to the .vsix file and run again."
    exit 1
}

# ── Check code CLI ─────────────────────────────────────────────────────
$CodeCmd = Get-Command code -ErrorAction SilentlyContinue
if (-not $CodeCmd) {
    Write-Host "Error: 'code' command not found."
    Write-Host "Open VS Code, then Ctrl+Shift+P and run: Shell Command: Install 'code' command in PATH"
    exit 1
}

# ── Close VS Code ──────────────────────────────────────────────────────
Write-Host ""
Write-Host "[1/5] Closing VS Code..."
Get-Process -Name "Code" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# ── Remove previous versions ───────────────────────────────────────────
Write-Host "[2/5] Removing previous PM Agent versions..."
$ExtDir = Join-Path $env:USERPROFILE ".vscode\extensions"
$Removed = 0

if (Test-Path $ExtDir) {
    Get-ChildItem -Path $ExtDir -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "*pm-agent*" } |
        ForEach-Object {
            Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
            $Removed++
        }
}

Write-Host "  Removed $Removed previous installation(s)"

# ── Clear stale caches ─────────────────────────────────────────────────
Write-Host "[3/5] Clearing stale caches..."
$AppDataCode = Join-Path $env:APPDATA "Code"

$CachePaths = @(
    (Join-Path $AppDataCode "Service Worker"),
    (Join-Path $AppDataCode "Webview"),
    (Join-Path $AppDataCode "CachedExtensions"),
    (Join-Path $AppDataCode "logs")
)

foreach ($Path in $CachePaths) {
    if (Test-Path $Path) {
        Remove-Item $Path -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ── Install ────────────────────────────────────────────────────────────
Write-Host "[4/5] Installing PM Agent v$Version..."
& code --install-extension $Vsix --force

# ── Verify ─────────────────────────────────────────────────────────────
Write-Host "[5/5] Verifying..."
$Found = 0

if (Test-Path $ExtDir) {
    $Found = (Get-ChildItem -Path $ExtDir -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "*pm-agent*" }).Count
}

if ($Found -eq 1) {
    Write-Host ""
    Write-Host "================================"
    Write-Host "PM Agent v$Version installed successfully."
    Write-Host ""
    Write-Host "Open VS Code and you should see:"
    Write-Host "  - PM Agent icon in the activity bar"
    Write-Host "  - Welcome notification with 'Configure Platform' button"
    Write-Host "================================"
}
else {
    Write-Host ""
    Write-Host "Installation may need manual verification."
    Write-Host "Try: code --install-extension `"$Vsix`" --force"
}

Read-Host "Press Enter to exit"