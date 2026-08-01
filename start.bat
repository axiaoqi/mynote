@echo off
setlocal
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
set "MYNOTE_EXIT=%ERRORLEVEL%"
if not "%MYNOTE_EXIT%"=="0" (
    echo.
    echo MyNote failed to start. The error is shown above.
    pause
)
exit /b %MYNOTE_EXIT%
