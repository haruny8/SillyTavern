@echo off
pushd %~dp0
set NODE_ENV=production

where bun >nul 2>&1
if %errorlevel% neq 0 (
    echo Bun was not found in PATH.
    echo Install Bun first, then run this file again.
    pause
    popd
    exit /b 1
)

call bun server.js %*
pause
popd