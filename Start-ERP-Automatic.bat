
@echo off
setlocal

REM Use the folder where this BAT file is located
cd /d "%~dp0"

REM Configure log folder
set "LOG=%~dp0DB_Backups\erp_startup.log"

if not exist "%~dp0DB_Backups" mkdir "%~dp0DB_Backups"

echo.>> "%LOG%"
echo ==================================================>> "%LOG%"
echo [%date% %time%] VYAVASTA startup requested>> "%LOG%"

REM Check Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo [%date% %time%] ERROR: Node.js not found>> "%LOG%"
    exit /b 1
)

REM Check NPM
where npm >nul 2>&1
if errorlevel 1 (
    echo [%date% %time%] ERROR: NPM not found>> "%LOG%"
    exit /b 1
)

REM Check environment file
if not exist "%~dp0.env" (
    echo [%date% %time%] ERROR: .env file missing>> "%LOG%"
    exit /b 1
)

REM Check production frontend
if not exist "%~dp0dist\index.html" (
    echo [%date% %time%] ERROR: Production build missing. Run npm run build.>> "%LOG%"
    exit /b 1
)

REM Wait up to 180 seconds for PostgreSQL
echo [%date% %time%] Checking PostgreSQL availability...>> "%LOG%"

set "DB_READY=0"

for /L %%i in (1,1,60) do (
    call npm.cmd run db:check >nul 2>&1
    if not errorlevel 1 (
        set "DB_READY=1"
        goto DATABASE_READY
    )
    timeout /t 3 /nobreak >nul
)

:DATABASE_READY

if "%DB_READY%"=="0" (
    echo [%date% %time%] ERROR: PostgreSQL unavailable after 180 seconds.>> "%LOG%"
    exit /b 1
)

echo [%date% %time%] PostgreSQL is ready.>> "%LOG%"

REM Start production ERP server
echo [%date% %time%] Starting Express production server...>> "%LOG%"

node server.js >> "%LOG%" 2>&1

echo [%date% %time%] ERP server stopped with exit code %ERRORLEVEL%.>> "%LOG%"

exit /b %ERRORLEVEL%
