@echo off
cd /d "%~dp0"
title AgentCodeGUI - DEV
echo.
echo   AgentCodeGUI - dev mode (HMR)
echo   ------------------------------------------------
echo   - Edit code and it auto-reloads in the app window.
echo   - Keep this console window open (logs show here).
echo   - To stop: press Ctrl+C in this window.
echo.
call npm run dev
echo.
echo   [dev server stopped]
pause
