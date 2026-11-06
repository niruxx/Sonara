@echo off
rem Double-click friendly wrapper for uninstall.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
if errorlevel 1 pause
