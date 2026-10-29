@echo off
rem OpenATC helper launcher for Windows. Double-click to run.
rem First run creates a private Python environment in .venv and installs the
rem dependencies (needs internet once). Extra arguments are passed on, e.g.
rem   start_openatc.bat --mock
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Creating Python environment...
  py -3 -m venv .venv 2>nul || python -m venv .venv
  if not exist ".venv\Scripts\python.exe" (
    echo Could not create the environment. Install 64-bit Python 3.11-3.13 from python.org
    echo and tick "Add python.exe to PATH". Then run this file again.
    pause
    exit /b 1
  )
  ".venv\Scripts\python.exe" -m pip install --upgrade pip
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt || (pause & exit /b 1)
)
".venv\Scripts\python.exe" -m openatc %*
pause
