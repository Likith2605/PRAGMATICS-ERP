@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title VYAVASTA ERP - Launcher

echo(
echo ============================================
echo     VYAVASTA ERP - one click launcher
echo ============================================
echo(

REM ---- 1. Node.js present? -----------------------------------
where node >nul 2>&1
if errorlevel 1 (
    echo [X] Node.js is NOT installed on this computer.
    echo     Install the LTS version from https://nodejs.org
    echo     then double-click this Start.bat again.
    echo.
    pause
    exit /b 1
)
where npm >nul 2>&1
if errorlevel 1 (
    echo [X] Node.js was found but npm is missing.
    echo     Reinstall Node.js from https://nodejs.org
    echo.
    pause
    exit /b 1
)
for /f "delims=" %%v in ('node --version') do set "NODE_VER=%%v"
echo [1/5] Node.js found: !NODE_VER!

REM ---- 2. .env present? ----------------------------------------
if not exist ".env" (
    echo [!] .env file not found.
    echo     Copy .env.example to .env and set DATABASE_URL / SMTP settings.
    echo     The app will still start but PostgreSQL sync will be disabled.
    echo.
)

REM ---- 3. Project folder + dependencies ----------------------
if not exist "package.json" (
    echo [X] package.json not found.
    echo     This Start.bat must sit INSIDE the project folder.
    echo.
    pause
    exit /b 1
)
if not exist "node_modules" (
    echo [2/5] Dependencies missing - running npm install now...
    echo       Needs internet once and may take a few minutes.
    call npm install
    if errorlevel 1 (
        echo [X] npm install failed - check your internet connection.
        pause
        exit /b 1
    )
) else (
    echo [2/5] Dependencies found.
)

REM ---- 4. Remember whether the frontend is already running ---
set "APP_RUNNING=0"
node -e "fetch('http://localhost:5173').then(()=>process.exit(0)).catch(()=>process.exit(1))" >nul 2>&1
if not errorlevel 1 (
    set "APP_RUNNING=1"
    echo [3/5] Frontend already running.
)

REM ---- 5. Backend API server on 3001 -------------------------
node -e "fetch('http://localhost:3001/api/health').then(()=>process.exit(0)).catch(()=>process.exit(1))" >nul 2>&1
if errorlevel 1 (
    if exist "server.js" (
        start "Pragmatics - API + Email Server" /min cmd /k "node server.js"
        echo [3/5] API/Email server started - minimized window.
        REM Wait briefly for the server to initialize
        ping -n 4 127.0.0.1 >nul
    ) else (
        echo [3/5] server.js not found - skipping API server.
    )
) else (
    echo [3/5] API server already running.
)

REM ---- 6. Run pending DB migrations (if DATABASE_URL is set) --
if exist ".env" (
    node -e "require('dotenv').config(); if(process.env.DATABASE_URL){process.exit(0);}else{process.exit(1);}" >nul 2>&1
    if not errorlevel 1 (
        echo [4/5] Running database migrations...
        node server/migrate.js
        if errorlevel 1 (
            echo [!] Migration warning - check output above. Continuing...
        ) else (
            echo [4/5] Migrations up to date.
        )
    ) else (
        echo [4/5] DATABASE_URL not set - skipping migrations.
    )
) else (
    echo [4/5] No .env file - skipping migrations.
)

REM ---- 7. Start the app ---------------------------------------
if "!APP_RUNNING!"=="1" goto :ready
start "Pragmatics - App Server" cmd /k npm run dev
echo [5/5] Starting the app in the "Pragmatics - App Server" window...

set /a TRIES=0
:poll
node -e "fetch('http://localhost:5173').then(()=>process.exit(0)).catch(()=>process.exit(1))" >nul 2>&1
if not errorlevel 1 goto :ready
set /a TRIES+=1
if !TRIES! geq 90 goto :timeout
ping -n 2 127.0.0.1 >nul
goto :poll

:timeout
echo(
echo [X] The app did not answer within 90 seconds.
echo     Check the "Pragmatics - App Server" window for errors.
echo.
pause
exit /b 1

:ready
echo(
echo [OK] App is running - http://localhost:5173
echo.
echo     * "App Server" window         - Vite frontend, keep it open
echo     * "API + Email Server" window - backend API + email, keep it open
echo     * To STOP: close both those windows
echo.
echo     Database health: http://localhost:3001/api/health
echo     Ballooning API:  http://localhost:3001/api/ballooning/health
echo.
start "" "http://localhost:5173"
pause
exit /b 0
