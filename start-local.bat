@echo off
rem Start a local static server for Traffic-Sim and open it in the browser.
cd /d "%~dp0"
set PORT=8080

where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python not found. Please install Python from https://www.python.org/
    pause
    exit /b 1
)

rem Open the browser after a short delay so the server is ready.
start "" cmd /c "timeout /t 2 >nul & start http://localhost:%PORT%"

echo Serving at http://localhost:%PORT%  (close this window or press Ctrl+C to stop)
python server.py %PORT%
pause
