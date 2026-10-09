@echo off
cd /d "%~dp0"

if exist "venv\Scripts\python.exe" (
    "venv\Scripts\python.exe" run.py --https
) else if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" run.py --https
) else (
    echo [ERROR] Could not find a virtual environment folder ^(venv or .venv^) in %CD%
)

pause