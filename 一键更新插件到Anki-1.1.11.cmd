@echo off
chcp 65001 >nul
title 互动答题卡 · 更新到 Anki
echo.
echo   互动答题卡 —— 把新版复制进 Anki 插件目录
echo   只覆盖插件的 8 个文件，不动 user_files（统计库 / 判断题标记 / 整理报告）
echo.
set "HERE=%~dp0"
set "PY=C:\Program Files\Lenovo\ModelMgr\Plugins\Image\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" "%HERE%安装到Anki.py"
echo.
echo   看到「已安装到 ...」就是装好了。重启 Anki 之后生效。
echo.
pause
