@echo off
REM PM Agent — Install / Reinstall Script (Windows)
REM Usage: install.bat
REM
REM This script cleanly installs PM Agent by removing any previous versions,
REM clearing stale caches, and installing the current VSIX.

setlocal enabledelayedexpansion

set VERSION=0.5.0
set VSIX=%~dp0pm-agent-%VERSION%.vsix

echo PM Agent v%VERSION% — Installer
echo ================================

REM ── Check VSIX exists ──────────────────────────────────────────────────
if not exist "%VSIX%" (
    echo Error: %VSIX% not found.
    echo Place this script next to the .vsix file and run again.
    exit /b 1
)

REM ── Check code CLI ─────────────────────────────────────────────────────
where code >nul 2>&1
if errorlevel 1 (
    echo Error: 'code' command not found.
    echo Open VS Code, then Ctrl+Shift+P → "Shell Command: Install 'code' command in PATH"
    exit /b 1
)

REM ── Close VS Code ──────────────────────────────────────────────────────
echo.
echo [1/5] Closing VS Code...
taskkill /IM "Code.exe" /F >nul 2>&1
timeout /t 2 /nobreak >nul

REM ── Remove previous versions ───────────────────────────────────────────
echo [2/5] Removing previous PM Agent versions...
set EXT_DIR=%USERPROFILE%\.vscode\extensions
set removed=0
for /D %%d in ("%EXT_DIR%\*pm-agent*") do (
    rmdir /S /Q "%%d" >nul 2>&1
    set /a removed+=1
)
echo   Removed %removed% previous installation(s)

REM ── Clear stale caches ─────────────────────────────────────────────────
echo [3/5] Clearing stale caches...
set APPDATA_CODE=%APPDATA%\Code
if exist "%APPDATA_CODE%\Service Worker" rmdir /S /Q "%APPDATA_CODE%\Service Worker" >nul 2>&1
if exist "%APPDATA_CODE%\Webview" rmdir /S /Q "%APPDATA_CODE%\Webview" >nul 2>&1
if exist "%APPDATA_CODE%\CachedExtensions" rmdir /S /Q "%APPDATA_CODE%\CachedExtensions" >nul 2>&1
if exist "%APPDATA_CODE%\logs" rmdir /S /Q "%APPDATA_CODE%\logs" >nul 2>&1

REM ── Install ────────────────────────────────────────────────────────────
echo [4/5] Installing PM Agent v%VERSION%...
call code --install-extension "%VSIX%" --force

REM ── Verify ─────────────────────────────────────────────────────────────
echo [5/5] Verifying...
set found=0
for /D %%d in ("%EXT_DIR%\*pm-agent*") do set /a found+=1

if %found% equ 1 (
    echo.
    echo ================================
    echo PM Agent v%VERSION% installed successfully.
    echo.
    echo Open VS Code and you should see:
    echo   - PM Agent icon in the activity bar
    echo   - Welcome notification with 'Configure Platform' button
    echo ================================
) else (
    echo.
    echo Installation may need manual verification.
    echo Try: code --install-extension "%VSIX%" --force
)

endlocal
pause
