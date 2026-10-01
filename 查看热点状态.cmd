@echo off
chcp 65001 >nul
title 个人热点服务状态
if not defined NEWS_WSL_DISTRO set "NEWS_WSL_DISTRO=Ubuntu"
wsl.exe -d "%NEWS_WSL_DISTRO%" --cd "%~dp0." --exec bash scripts/wsl-runtime.sh status
echo.
echo 按任意键关闭；再次双击可刷新状态。
pause >nul
