@echo off
cd /d "%~dp0"
node generateImgStrip.js --watch
pause
