@echo off
chcp 65001 >nul
title Audit-EE — Sync รูปภาพจาก Cloud
cd /d "%~dp0"
echo.
echo  ╔══════════════════════════════════════╗
echo  ║   Audit-EE  ·  Sync รูปภาพ Cloud    ║
echo  ╚══════════════════════════════════════╝
echo.
node sync-local.js
echo.
pause
