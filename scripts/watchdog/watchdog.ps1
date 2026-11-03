# Second line of defence for the daily-shorts workflow, run hourly on this PC
# by Task Scheduler (scripts/watchdog/install.ps1).
#
# GitHub's schedule is best effort: it dropped the 07:30 run on 2026-11-02 and
# both 07:30 and 13:15 on 2026-11-03. The workflow has six slots a day; this
# covers a day where GitHub sheds all of them. From 10:00 UTC on, if a channel
# is still short of today's story shorts (scripts/autopilot/day-check.js on the
# committed state) and no run started in the last 3 hours, it starts one.
# A run started here is the same run as the scheduled ones: the autopilot only
# posts what a channel is still missing, so it cannot post the day twice.
#
# Log: watchdog.log next to this script (last 500 lines kept, not committed).

$ErrorActionPreference = 'Stop'
$repo = 'chentoufoussama06-netizen/youtube-automation-engine'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$logFile = Join-Path $PSScriptRoot 'watchdog.log'

function Log($msg) {
  $line = '{0:u} {1}' -f (Get-Date).ToUniversalTime(), $msg
  Add-Content -Path $logFile -Value $line -Encoding utf8
  $lines = Get-Content $logFile
  if ($lines.Count -gt 500) { $lines | Select-Object -Last 500 | Set-Content $logFile -Encoding utf8 }
}

try {
  $now = (Get-Date).ToUniversalTime()
  if ($now.Hour -lt 10) { exit 0 }   # the 07:30 and 09:40 slots get their chance first

  $env:GH_TOKEN = (& gh auth token --user chentoufoussama06-netizen).Trim()

  $runs = & gh run list -R $repo --workflow daily-shorts.yml -L 10 --json status,createdAt | ConvertFrom-Json
  if ($runs | Where-Object { $_.status -ne 'completed' }) { exit 0 }   # one is running or queued
  $recent = $runs | Where-Object { ($now - ([datetime]$_.createdAt).ToUniversalTime()).TotalHours -lt 3 }
  if ($recent) { exit 0 }

  & git -C $root fetch -q cloud main
  $short = & node (Join-Path $root 'scripts/autopilot/day-check.js') --ref cloud/main
  if (-not $short) { exit 0 }

  & gh workflow run daily-shorts.yml -R $repo --ref main
  Log ("started a run, short: " + ($short -join '; '))
} catch {
  Log ("error: " + $_.Exception.Message)
}
