@echo off
REM OpenClaw + Cognee Memory Startup Script
REM This script handles all setup and starts both services

echo ============================================
echo  OpenClaw + Cognee Memory Startup
echo ============================================
echo.

REM Check for pnpm
where pnpm >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [1/4] Installing pnpm...
    call npm install -g pnpm
) else (
    echo [1/4] pnpm already installed
)

REM Install dependencies
echo [2/4] Installing dependencies...
call pnpm install

REM Check for OpenAI API key
if "%OPENAI_API_KEY%"=="" (
    echo.
    echo ERROR: OPENAI_API_KEY environment variable not set.
    echo.
    echo Set it before running this script:
    echo   set OPENAI_API_KEY=sk-proj-...
    echo   start.bat
    echo.
    pause
    exit /b 1
)

REM Start Cognee bridge in background
echo [3/4] Starting Cognee bridge server...
cd extensions\memory-cognee\bridge

REM Check if venv exists, create if not
if not exist ".venv" (
    echo Creating Python virtual environment...
    py -3.12 -m venv .venv
    call .venv\Scripts\pip install -r requirements.txt
)

REM Start bridge in new window
start "Cognee Bridge" cmd /k ".venv\Scripts\activate && python start_server.py"

REM Wait for bridge to start
echo Waiting for Cognee bridge to start...
timeout /t 3 /nobreak >nul

REM Go back to root and start OpenClaw
cd ..\..\..
echo [4/4] Starting OpenClaw...
echo.
echo ============================================
echo  Both services starting!
echo  - Cognee bridge: http://localhost:8001
echo  - OpenClaw: Starting now...
echo ============================================
echo.

call npm start
