@echo off
setlocal

cd /d "%~dp0"

where node.exe >nul 2>&1
if errorlevel 1 (
    echo ERROR: node.exe was not found in PATH.
    echo Install Node.js or add it to PATH, then try again.
    pause
    exit /b 1
)

if not exist "%~dp0server.js" (
    echo ERROR: server.js was not found.
    echo Expected: "%~dp0server.js"
    pause
    exit /b 1
)

rem Open the browser shortly after the direct Node process starts.
start "" /b "%~dp0open-dashboard.cmd"

rem Run Node directly in this console so startup errors remain visible.
node.exe server.js

if errorlevel 1 (
    echo.
    echo ERROR: server.js exited with an error.
    pause
    exit /b 1
)

endlocal
