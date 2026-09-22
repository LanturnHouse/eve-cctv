@echo off
title EVE CCTV Watcher
cd /d "%~dp0"

echo ============================================
echo  Starting EVE CCTV watcher...
echo  (closing this window stops the watcher)
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not on PATH.
    echo Install it from https://nodejs.org and try again.
    pause
    exit /b 1
)

call npm run dev

echo.
echo Stopped.
pause
