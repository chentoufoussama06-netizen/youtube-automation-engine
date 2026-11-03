# Registers watchdog.ps1 with Task Scheduler: every hour while this user is
# logged on, and once at logon. Run again to update; remove with
#   Unregister-ScheduledTask -TaskName 'YouTube autopilot watchdog' -Confirm:$false

$name = 'YouTube autopilot watchdog'
$script = Join-Path $PSScriptRoot 'watchdog.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$hourly = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Hours 1)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $name -Action $action -Trigger $hourly, $logon -Settings $settings `
  -Description 'Starts the daily-shorts workflow when GitHub skipped the day (scripts/watchdog/watchdog.ps1).' -Force | Out-Null
"registered '$name'"
