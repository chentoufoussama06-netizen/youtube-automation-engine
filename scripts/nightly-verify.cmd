@echo off
REM Nightly source-layer verification. Ledger only: never renders, never
REM publishes, never approves. Task Scheduler starts a task in system32, so
REM the working directory must be set or dotenv finds no .env.
REM ASCII only: a non-ASCII character here makes cmd.exe fail to parse REM.
cd /d "%~dp0.."
node scripts\maintenance\nightly-verify.js >> logs\nightlyverify.log 2>&1
