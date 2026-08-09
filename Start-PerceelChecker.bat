@echo off
echo ============================================
echo   PERCEEL CHECKER — Landmeterstool
echo ============================================
echo.
echo Starten op http://localhost:8767
echo Sluit dit venster om de server te stoppen.
echo.

:: Controleer Python
where py >nul 2>&1
if %errorlevel% neq 0 (
    echo FOUT: Python niet gevonden.
    echo Installeer Python via https://www.python.org
    pause
    exit /b 1
)

:: Start browser na korte wachttijd
start "" /b cmd /c "timeout /t 2 >nul && start http://localhost:8767"

:: Start lokale server + CadGIS proxy in deze map
cd /d "%~dp0"
py -3 perceel_checker_server.py 8767
