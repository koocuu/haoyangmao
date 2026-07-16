@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 好羊毛雷达 - 桌面自动化服务
echo 正在启动好羊毛雷达...
echo.
echo 页面地址: http://127.0.0.1:8765
echo.
echo 这个窗口不要关。用这个窗口启动时，截图/OCR 才能看到你的微信 PC、小程序窗口。
echo.
node automation-server.js
pause
