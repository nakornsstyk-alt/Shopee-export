@echo off
title Start Chrome - Debug Mode
echo ============================================================
echo   Starting Chrome with remote debugging on port 9222
echo ============================================================
echo.

:: Try common Chrome install locations
set "CHROME_PATH="

if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    set "CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe"
) else if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
    set "CHROME_PATH=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
) else if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" (
    set "CHROME_PATH=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
)

if "%CHROME_PATH%"=="" (
    echo [ERROR] Chrome not found in standard locations.
    echo.
    echo Please run this command manually in a new CMD window:
    echo.
    echo   "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=C:\chrome_debug
    echo.
    pause
    exit /b 1
)

echo Found Chrome at:
echo   %CHROME_PATH%
echo.
echo Launching Chrome with debug port 9222...
echo Keep this window open while using the scraper.
echo.

"%CHROME_PATH%" --remote-debugging-port=9222 --user-data-dir=C:\chrome_debug

echo.
echo Chrome has closed.
pause
