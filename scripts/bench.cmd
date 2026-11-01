@echo off
set SCRIPT_DIR=%~dp0
set PYTHON_EXE=%SCRIPT_DIR%..\namma\backend\python-service\venv\Scripts\python.exe
"%PYTHON_EXE%" "%SCRIPT_DIR%bench.py" %*
