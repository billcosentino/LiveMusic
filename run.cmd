@echo off
rem Nightly job: refresh venues weekly, scrape events, rebuild the calendar. Logs go to logs\.
cd /d "%~dp0"
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%i
set LOG=logs\run-%TODAY%.log
if not exist logs mkdir logs
echo ==== %DATE% %TIME% ==== >> "%LOG%"
node src\venues.js --if-stale >> "%LOG%" 2>&1
node src\scrape.js >> "%LOG%" 2>&1
rem If Node crashed partway, run again: venues already checked in the last 12h are skipped.
if errorlevel 1 node src\scrape.js >> "%LOG%" 2>&1
if errorlevel 1 node src\scrape.js >> "%LOG%" 2>&1
node src\build.js >> "%LOG%" 2>&1
rem Push the rebuilt calendar to GitHub Pages (skipped quietly if there's no GitHub remote).
git remote get-url origin >nul 2>&1 && node src\publish.js >> "%LOG%" 2>&1
rem keep the last 30 logs
powershell -NoProfile -Command "Get-ChildItem logs\run-*.log | Sort-Object Name -Descending | Select-Object -Skip 30 | Remove-Item"
