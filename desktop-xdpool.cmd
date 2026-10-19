@echo off
setlocal
cd /d "%~dp0"

echo [XD Pool] Switching Claude desktop to the bridge profile...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0desktop-profile.ps1" -Target xdpool
if errorlevel 1 (
  echo.
  echo Switch failed. Read the message above, then try again.
  pause
  exit /b 1
)

netstat -ano | findstr "127.0.0.1:8327" | findstr "LISTENING" >nul
if errorlevel 1 (
  echo [XD Pool] Starting the bridge...
  start "XD Pool Bridge" /D "%~dp0" cmd /c "node --experimental-transform-types --no-warnings bridge.ts"
  timeout /t 3 /nobreak >nul
) else (
  echo [XD Pool] Bridge already listening on 8327.
)

echo [XD Pool] Starting Claude desktop...
explorer.exe "shell:AppsFolder\Claude_pzs8sxrjxfjjc!Claude"

echo.
echo Done. Claude desktop now uses http://127.0.0.1:8327.
echo All three model slots map to deepseek-v4.1-flash.
pause
