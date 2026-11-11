@echo off
rem Registers a Windows scheduled task that runs run.cmd every night at 3:00 AM.
rem   schedule.cmd          install / update the task
rem   schedule.cmd remove   delete the task
set TASK=GigCalendarNightly
if /i "%1"=="remove" (
  schtasks /Delete /TN "%TASK%" /F
  goto :eof
)
schtasks /Create /TN "%TASK%" /TR "\"%~dp0run.cmd\"" /SC DAILY /ST 03:00 /F
if errorlevel 1 goto :eof
rem Run even if the PC was asleep/off at 3 AM, as soon as it's back on.
powershell -NoProfile -Command "$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 4); Set-ScheduledTask -TaskName '%TASK%' -Settings $s | Out-Null"
echo Task "%TASK%" will run nightly at 3:00 AM. Check it in Task Scheduler.
