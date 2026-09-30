@echo off
ping 127.0.0.1 -n 3 >nul
start "" "http://127.0.0.1:48763/"
exit /b 0
