#!/usr/bin/env node
/**
 * Make a channel's upload ledger agree with YouTube.
 *
 *   node scripts/reconcile-ledger.js --dry-run
 *   YT_TOKENS_FILE=tokens.clips.json DATA_ROOT=data/clips-channel node scripts/reconcile-ledger.js
 *
 * The ledger decides two things: what counts as "already uploaded", and what the
 * dashboard believes is live. When it drifts from YouTube both answers are
 * wrong, and neither failure announces itself.
 *
 * It has drifted twice, both on 2026-09-19:
 *
 *   - Eight clips were public on YouTube while the ledger still called them
 *     private, because upload-shorts.js used to write back the whole ledger
 *     object it had read at startup, erasing a publish that happened in
 *     between. That write merges now, so this particular cause is gone.
 *   - A short (`klinsmann`) was listed as public but no longer existed on
 *     YouTube at all — removed at some point with nothing recording it.
 *
 * Either way YouTube is the authority and this file is a cache, so this reads
 * the first and rewrites the second. Vanished videos are flagged rather than
 * deleted: dropping the row would let the pipeline cheerfully re-upload
 * something YouTube already took down once.
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
const logger = new Logger('ReconcileLedger');

function authorize() {
  const creds = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'credentials.json'), 'utf8')).youtube;
  const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', YT_TOKENS_FILE), 'utf8')).youtube;
  const oauth = new google.auth.OAuth2(creds.client_id, creds.client_secret, (creds.redirect_uris || [])[0]);
  oauth.setCredentials(tokens);
  return google.youtube({ version: 'v3', auth: oauth });
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const ledger = JSON.parse(await fsp.readFile(LEDGER_PATH, 'utf8'));
  const entries = Object.entries(ledger).filter(([, v]) => v.videoId);

  if (!entries.length) {
    logger.info('Ledger is empty — nothing to reconcile.');
    return;
  }

  const youtube = authorize();
  const live = new Map();

  // videos.list takes up to 50 ids per call and costs 1 unit either way, so
  // batching keeps a 300-video ledger to six units rather than three hundred.
  for (let i = 0; i < entries.length; i += 50) {
    const batch = entries.slice(i, i + 50);
    const res = await youtube.videos.list({ part: 'status', id: batch.map(([, v]) => v.videoId).join(',') });
    for (const v of res.data.items || []) live.set(v.id, v.status.privacyStatus);
  }

  const changed = [];
  const missing = [];

  for (const [id, entry] of entries) {
    const actual = live.get(entry.videoId);

    if (!actual) {
      if (entry.missingOnYouTube) continue;       // already flagged on an earlier run
      missing.push(id);
      if (!dryRun) {
        entry.missingOnYouTube = true;
        entry.missingNoticedAt = new Date().toISOString();
      }
      continue;
    }

    if (actual !== entry.privacyStatus) {
      changed.push(`${id}: ${entry.privacyStatus} -> ${actual}`);
      if (!dryRun) {
        entry.privacyStatus = actual;
        if (actual === 'public' && !entry.publishedAt) entry.publishedAt = new Date().toISOString();
      }
    }
  }

  for (const line of changed) logger.info(`  ${line}`);
  for (const id of missing) logger.warn(`  ${id}: no longer on YouTube (${ledger[id].url}) — flagged, not deleted`);

  if (!changed.length && !missing.length) {
    logger.success(`${entries.length} entries checked — ledger already matches YouTube.`);
    return;
  }

  if (dryRun) {
    logger.info(`[dry-run] ${changed.length} status change(s), ${missing.length} missing — nothing written.`);
    return;
  }

  await fsp.writeFile(LEDGER_PATH, JSON.stringify(ledger, null, 2));
  logger.success(`${changed.length} status change(s), ${missing.length} missing video(s) -> ${LEDGER_PATH}`);
}

if (require.main === module) {
  main().catch((error) => {
    logger.error(`reconcile-ledger failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { main };
