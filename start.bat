@echo off
REM ----------------------------------------------------------
REM DIVI - one-click launcher for Windows
REM Opens the backend API + frontend in two new terminals
REM and then opens the app in your default browser.
REM
REM Prereqs (do these ONCE):
REM   1. Install Node.js LTS  : https://nodejs.org
REM   2. Install MongoDB       : https://www.mongodb.com/try/download/community
REM      and either run it as a Windows Service or start `mongod`.
REM   3. Edit backend\.env and set a strong JWT_SECRET.
REM ----------------------------------------------------------

setlocal
cd /d "%~dp0"

echo.
echo === DIVI launcher ===
echo Project folder: %CD%
echo.

REM --- Backend deps ---------------------------------------------------------
if not exist "backend\node_modules\" (
    echo [1/3] Installing backend dependencies (one-time)...
    pushd backend
    call npm install
    popd
) else (
    echo [1/3] Backend deps already installed.
)

REM --- .env sanity check ----------------------------------------------------
if not exist "backend\.env" (
    echo.
    echo WARNING: backend\.env is missing.
    echo Copying .env.example to .env. You MUST edit it and set JWT_SECRET.
    copy /y "backend\.env.example" "backend\.env" >nul
    notepad "backend\.env"
)

REM --- Launch backend in its own window -------------------------------------
echo [2/3] Starting backend (http://localhost:5000) ...
start "DIVI backend" cmd /k "cd /d %~dp0backend && npm start"

REM --- Launch frontend in its own window ------------------------------------
echo [3/3] Starting frontend (http://localhost:5500) ...
start "DIVI frontend" cmd /k "cd /d %~dp0frontend && npm start"

REM --- Give them a couple of seconds, then open the browser ----------------
timeout /t 4 /nobreak >nul
start "" "http://localhost:5500"

echo.
echo Both servers are launching in their own windows.
echo Close those windows to stop the servers.
echo.
endlocal
