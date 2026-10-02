@echo off
REM Hourly WHOP OS refresh. Task Scheduler starts a task in system32 by
REM default, so the working directory has to be set explicitly or dotenv
REM finds no .env and the sync writes nowhere.
cd /d "%~dp0.."
node scripts\youtube\sync-dashboard.js --days 28 >> logs\syncdashboard.log 2>&1
