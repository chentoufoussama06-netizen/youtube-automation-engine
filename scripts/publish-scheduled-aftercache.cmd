@echo off
REM Publishes any AFTER CACHE short whose scheduledPublishAt has passed.
REM Runs every 15 minutes. A schedule nothing wakes up to honour is just a
REM field in a JSON file, which is how two shorts once sat private for hours
REM past their slot.
REM
REM Task Scheduler starts a task in system32, so the working directory has to
REM be set explicitly or dotenv finds no .env and the publish has no tokens.
REM ASCII only: a non-ASCII character here makes cmd.exe fail to parse REM.
cd /d "%~dp0.."
set DATA_ROOT=data/aftercache
set YT_TOKENS_FILE=tokens.aftercache.json
node scripts\youtube\check-scheduled.js >> logs\checkscheduled-aftercache.log 2>&1
