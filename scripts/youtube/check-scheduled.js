#!/usr/bin/env node
/**
 * Publish any short whose scheduledPublishAt has passed. Meant to run on a
 * short interval (a Windows Scheduled Task, cron, whatever) — NOT invoked
 * once and left. This is the fix for a real bug: the old flow only checked
 * scheduled times whenever upload-shorts.js happened to run next, which sat
 * two shorts private for 5-7 hours past their scheduled slot (see the
 * Furiani/Guatemala96 incident). A short scheduled for a specific hour is
 * worthless if nothing wakes up near that hour to actually flip it.
 *
 *   node scripts/check-scheduled.js              # publish anything due
 *   node scripts/check-scheduled.js --dry-run     # show what's due, change nothing
 */

require('dotenv').config();

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { google } = require('googleapis');
const { Logger } = require('../../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const DATA_ROOT = process.env.DATA_ROOT || 'data';
const YT_TOKENS_FILE = process.env.YT_TOKENS_FILE || 'tokens.json';
const LEDGER_PATH = path.join(ROOT, DATA_ROOT, 'shorts', 'uploads.json');
const logger = new Logger('CheckScheduled');

function authorize() {
  const creds = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'credentials.json'), 'utf8')).youtube;
  const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', YT_TOKENS_FILE), 'utf8')).youtube;
  const oauth = new google.auth.OAuth2(creds.client_id, creds.client_secret, (creds.redirect_uris || [])[0]);
  oauth.setCredentials(tokens);
  return google.youtube({ version: 'v3', auth: oauth });
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const ledger = JSON.parse(await fsp.readFile(LEDGER_PATH, 'utf8').catch(() => '{}'));
  const now = Date.now();

  const due = Object.entries(ledger).filter(([, entry]) =>
    entry.privacyStatus === 'private' && entry.scheduledPublishAt && new Date(entry.scheduledPublishAt).getTime() <= now
  );

  if (!due.length) {
    logger.info('Nothing due.');
    return;
  }

  const youtube = dryRun ? null : authorize();
  for (const [jobId, entry] of due) {
    if (dryRun) {
      logger.info(`[dry-run] would publish ${jobId} (scheduled ${entry.scheduledPublishAt}) -> ${entry.url}`);
      continue;
    }
    try {
      await youtube.videos.update({
        part: 'status',
        requestBody: { id: entry.videoId, status: { privacyStatus: 'public', selfDeclaredMadeForKids: false } }
      });
      entry.privacyStatus = 'public';
      entry.publishedAt = new Date().toISOString();
      await fsp.writeFile(LEDGER_PATH, JSON.stringify(ledger, null, 2));
      logger.success(`${jobId} is PUBLIC (was scheduled ${entry.scheduledPublishAt}) -> ${entry.url}`);
    } catch (error) {
      logger.error(`${jobId} failed: ${error.message}`);
    }
  }
}

main().catch(error => {
  logger.error(`check-scheduled failed: ${error.message}`);
  process.exit(1);
});
