@echo off
rem Double-click friendly wrapper for update.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1" %*
if errorlevel 1 pause
