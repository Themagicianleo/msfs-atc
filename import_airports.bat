@echo off
rem Downloads the free OurAirports data (about 20 MB) and builds the local database.
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Run start_openatc.bat once first, it sets up Python.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -m openatc import-airports %*
pause
