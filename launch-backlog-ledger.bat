@echo off
setlocal

cd /d "%~dp0"
title The Backlog Ledger

echo.
echo ========================================
echo        The Backlog Ledger Launcher
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on this computer.
  echo Install Node.js, then run this launcher again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo.
    echo Dependency install failed.
    pause
    exit /b 1
  )
  echo.
)

echo Starting The Backlog Ledger...
echo Open http://localhost:47821 in your browser.
echo.
echo Press Ctrl+C in this window to stop the server.
echo.

call npm start

echo.
echo The Backlog Ledger has stopped.
pause
