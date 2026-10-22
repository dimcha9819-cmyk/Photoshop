@echo off
rem ============================================================
rem  Setup.bat
rem  Nastroyka naborov operatsiy .atn pod etu mashinu.
rem  Dvoynoy klik - puti budut ukazyvat na papku Scripts ryadom.
rem  Drugaya papka: perettashchite ee na etot .bat
rem ============================================================
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
    echo Python ne nayden. Ustanovite Python 3.8 ili novee:
    echo   https://www.python.org/downloads/
    echo Pri ustanovke otmette "Add Python to PATH".
    echo.
    pause
    exit /b 1
)

python "tools\setup.py" %*
echo.
pause
