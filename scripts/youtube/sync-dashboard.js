#!/usr/bin/env node
/**
 * Push every channel's numbers into the WHOP OS dashboard.
 *
 *   node scripts/sync-dashboard.js              # all channels, 28-day window
 *   node scripts/sync-dashboard.js --days 7
 *   node scripts/sync-dashboard.js --channel clips
 *
 * The uploaders already record a subscriber/view snapshot after each run, but a
 * snapshot is only ever three numbers. The things actually worth looking at —
 * watch time, average view duration, how many viewers converted to subscribers,
 * and where the views came from — live in the YouTube ANALYTICS API, which is
 * private to the channel owner. WHOP OS holds an API key, and an API key can
 * never read those at any price; this repo holds the OAuth credential for all
 * three channels, so collection has to happen here and be written across.
 *
 * Read-only against YouTube. Safe to run as often as you like: each run stores
 * a new dated row rather than overwriting, which is what gives the dashboard a
 * trend instead of a single reading.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { Logger } = require('../../utils/logger');
const { pushChannelSnapshot, readChannel, pushChannelAnalytics, pushTrackedVideos } = require('../../utils/whop-os');

const ROOT = path.join(__dirname, '..', '..');
const logger = new Logger('SyncDashboard');

// Every channel this machine can authenticate as, by short name.
// Each channel's token plus the data root holding its upload ledger, so the
// per-video tracker can be filled from the right one.
const CHANNELS = {
  football: { tokens: 'tokens.json', dataRoot: 'data' },
  aftercache: { tokens: 'tokens.aftercache.json', dataRoot: 'data/aftercache' },
  clips: { tokens: 'tokens.clips.json', dataRoot: 'data/clips-channel' }
};

function authFor(tokensFile) {
  const creds = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'credentials.json'), 'utf8')).youtube;
  const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', tokensFile), 'utf8')).youtube;
  const oauth = new google.auth.OAuth2(creds.client_id, creds.client_secret, (creds.redirect_uris || [])[0]);
  oauth.setCredentials(tokens);
  return oauth;
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag, def) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : def);
  const days = Number(get('--days', '28')) || 28;
  const only = get('--channel');

  if (!process.env.WHOP_OS_DATABASE_URL) {
    throw new Error('WHOP_OS_DATABASE_URL is not set — nothing to write to.');
  }
  if (only && !CHANNELS[only]) {
    throw new Error(`unknown channel "${only}" — one of: ${Object.keys(CHANNELS).join(', ')}`);
  }

  const wanted = only ? { [only]: CHANNELS[only] } : CHANNELS;
  let ok = 0;

  for (const [name, { tokens: tokensFile, dataRoot }] of Object.entries(wanted)) {
    if (!fs.existsSync(path.join(ROOT, 'config', tokensFile))) {
      logger.warn(`${name}: no ${tokensFile} — not authorized yet, skipping`);
      continue;
    }

    try {
      const auth = authFor(tokensFile);
      const channel = await readChannel(google.youtube({ version: 'v3', auth }));
      await pushChannelSnapshot(channel);
      await pushChannelAnalytics(auth, channel.channelId, { days });

      // Fill the per-video tracker from this channel's own upload ledger.
      const ledgerPath = path.join(ROOT, dataRoot, 'shorts', 'uploads.json');
      if (fs.existsSync(ledgerPath)) {
        const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
        await pushTrackedVideos(auth, ledger, channel.title);
      }
      ok++;
    } catch (error) {
      // One dead credential must not stop the others being collected.
      logger.warn(`${name}: ${String(error.message).slice(0, 100)}`);
    }
  }

  logger.success(`${ok} channel(s) synced over a ${days}-day window.`);
}

if (require.main === module) {
  main().catch((error) => {
    logger.error(`sync-dashboard failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { CHANNELS };
