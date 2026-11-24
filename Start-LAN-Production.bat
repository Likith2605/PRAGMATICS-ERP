@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title VYAVASTA ERP - LAN Production Server

echo.
echo ==========================================================
echo        VYAVASTA ERP - LAN Production Server
echo ==========================================================
echo.

REM ---- 1. Check Node.js -------------------------------------
where node >nul 2>&1
if errorlevel 1 (
    echo [X] Node.js is NOT installed on this computer.
    echo     Please install Node.js [LTS version] from https://nodejs.org
    echo.
    pause
    exit /b 1
)
for /f "delims=" %%v in ('node --version') do set "NODE_VER=%%v"
echo [1/6] Node.js found: !NODE_VER!

REM ---- 2. Check .env configuration --------------------------
if not exist ".env" (
    echo [X] .env file not found.
    echo     Copy .env.example to .env and configure DATABASE_URL.
    echo.
    pause
    exit /b 1
)
echo [2/6] Environment configuration [.env] verified.

REM ---- 3. Check dependencies --------------------------------
if not exist "node_modules" (
    echo [3/6] node_modules missing. Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo [X] npm install failed. Check your internet connection.
        pause
        exit /b 1
    )
) else (
    echo [3/6] Dependencies verified.
)

REM ---- 4. Check production build (dist directory) -----------
if not exist "dist\index.html" (
    echo [4/6] Production frontend bundle missing. Building now...
    call npm run build
    if errorlevel 1 (
        echo [X] Production build failed. Check error log above.
        pause
        exit /b 1
    )
    echo [4/6] Production build completed.
) else (
    echo [4/6] Production build [dist folder] verified.
)

REM ---- 5. Check database & apply migrations -----------------
echo [5/6] Checking PostgreSQL database connection...
call npm run db:check >nul 2>&1
if errorlevel 1 (
    echo.
    echo [!] WARNING: PostgreSQL database is not reachable at DATABASE_URL.
    echo     Make sure the PostgreSQL service is running in Windows Services [services.msc].
    echo     The server will start, but database synchronization will be unavailable.
    echo.
) else (
    echo [5/6] PostgreSQL database is connected.
    echo       Applying any pending database migrations...
    call node server/migrate.js
    if errorlevel 1 (
        echo [!] Migration warning - check output above. Continuing startup...
    ) else (
        echo       Migrations are up to date.
    )
)

REM ---- 6. Detect LAN IP Addresses & Display Banner ----------
echo [6/6] Detecting LAN IP addresses for office access...
call node server/lanInfo.js

REM Launch browser locally
start "" "http://localhost:3001"

REM Start production Express server
call node server.js
