@echo off
rem Double-click to start Remo AI Learning Platform on Windows.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" %*
if errorlevel 1 pause
