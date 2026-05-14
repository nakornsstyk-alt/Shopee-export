@echo off
title Shopee Scraper (Category) - Setup
echo ============================================================
echo   Shopee Scraper (Category) - Windows Setup
echo ============================================================
echo.

:: Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found. Please install Python 3.12 from:
    echo         https://www.python.org/downloads/
    echo         Make sure to check "Add Python to PATH"
    pause
    exit /b 1
)

echo [1/4] Creating virtual environment...
python -m venv venv
if errorlevel 1 (
    echo [ERROR] Failed to create venv
    pause
    exit /b 1
)

echo [2/4] Activating venv and installing packages...
call venv\Scripts\activate.bat

pip install --upgrade pip --quiet
pip install playwright google-api-python-client google-auth-httplib2 google-auth-oauthlib --quiet

if errorlevel 1 (
    echo [ERROR] pip install failed
    pause
    exit /b 1
)

echo [3/4] Installing Playwright Chromium...
playwright install chromium
if errorlevel 1 (
    echo [WARNING] Playwright browser install may have partially failed
)

echo [4/4] Setup complete!
echo.
echo ============================================================
echo   BEFORE RUNNING THE APP each session:
echo.
echo   Run start_chrome_debug.bat (or click the button in the app)
echo   Log in to shopee.co.th in that Chrome window.
echo   Then run: launch.bat
echo ============================================================
echo.
pause
