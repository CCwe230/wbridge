@echo off
setlocal
cd /d "%~dp0"

echo [XD Pool] Restoring the CC Switch deployment profile...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0desktop-profile.ps1" -Target ccswitch
if errorlevel 1 (
  echo.
  echo Switch failed. Read the message above, then try again.
  pause
  exit /b 1
)

echo [XD Pool] Starting Claude desktop...
explorer.exe "shell:AppsFolder\Claude_pzs8sxrjxfjjc!Claude"

echo.
echo Done. Claude desktop is back on the CC Switch profile.
pause
