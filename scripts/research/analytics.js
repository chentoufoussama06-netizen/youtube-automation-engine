#!/usr/bin/env node
/**
 * Read the channel's own numbers back.
 *
 *   node scripts/analytics.js                       # every video, last 28 days
 *   node scripts/analytics.js --days 7
 *   node scripts/analytics.js --retention escobar   # where viewers drop
 *
 * This is the half of the loop that decides what to make next. Everything else
 * in this repo produces videos; this is the only thing that says whether they
 * worked.
 *
 * The metric that matters is NOT views. It is averageViewPercentage and the
 * retention curve: a cliff in the opening seconds means the hook failed, a
 * steady bleed means pacing. Views only say the algorithm showed it to people;
 * retention says whether the video deserved it.
 *
 * Read-only by design — nothing here can change or publish a video.
 */

require('dotenv').config();

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { google } = require('googleapis');
const { Logger } = require('../../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const LEDGER_PATH = path.join(ROOT, 'data', 'shorts', 'uploads.json');
const logger = new Logger('Analytics');

function authorize() {
  const creds = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'credentials.json'), 'utf8')).youtube;
  const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'tokens.json'), 'utf8')).youtube;
  const oauth = new google.auth.OAuth2(creds.client_id, creds.client_secret, (creds.redirect_uris || [])[0]);
  oauth.setCredentials(tokens);
  return oauth;
}

const asDate = (d) => d.toISOString().slice(0, 10);   // the API wants YYYY-MM-DD

async function overview(analytics, days) {
  const res = await analytics.reports.query({
    ids: 'channel==MINE',
    startDate: asDate(new Date(Date.now() - days * 86400000)),
    endDate: asDate(new Date()),
    metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained',
    dimensions: 'video',
    sort: '-views',
    maxResults: 50
  });

  const rows = res.data.rows || [];
  if (!rows.length) {
    logger.warn('No data yet. YouTube Analytics lags several hours behind publishing, '
      + 'and a video with no views produces no row at all.');
    return [];
  }

  const ledger = JSON.parse(await fsp.readFile(LEDGER_PATH, 'utf8').catch(() => '{}'));
  const nameOf = (videoId) => {
    const hit = Object.entries(ledger).find(([, v]) => v.videoId === videoId);
    return hit ? hit[0] : videoId;
  };

  console.log('\n' + 'topic'.padEnd(16) + 'views'.padStart(7) + 'avg%'.padStart(7)
    + 'avg sec'.padStart(9) + 'mins'.padStart(7) + 'subs'.padStart(6));
  console.log('-'.repeat(52));
  for (const [videoId, views, minutes, avgDuration, avgPercent, subs] of rows) {
    console.log(nameOf(videoId).padEnd(16)
      + String(views).padStart(7)
      + `${Number(avgPercent).toFixed(1)}%`.padStart(7)
      + `${Number(avgDuration).toFixed(0)}s`.padStart(9)
      + String(Math.round(minutes)).padStart(7)
      + String(subs).padStart(6));
  }

  const totals = rows.reduce((a, r) => ({
    views: a.views + r[1], minutes: a.minutes + r[2], subs: a.subs + r[5]
  }), { views: 0, minutes: 0, subs: 0 });
  console.log('-'.repeat(52));
  console.log(`${rows.length} video(s)  ${totals.views} views  `
    + `${Math.round(totals.minutes)} min watched  +${totals.subs} subs\n`);

  return rows;
}

/**
 * The retention curve, reported at 1% intervals of video length.
 * audienceWatchRatio of 1.0 means everyone who started was still watching.
 * The first buckets are the hook; everything after is pacing.
 */
async function retention(analytics, videoId, label) {
  const res = await analytics.reports.query({
    ids: 'channel==MINE',
    startDate: asDate(new Date(Date.now() - 90 * 86400000)),
    endDate: asDate(new Date()),
    metrics: 'audienceWatchRatio',
    dimensions: 'elapsedVideoTimeRatio',
    filters: `video==${videoId}`,
    sort: 'elapsedVideoTimeRatio'
  });

  const rows = res.data.rows || [];
  if (!rows.length) {
    logger.warn(`No retention data for ${label} yet — needs views and several hours.`);
    return;
  }

  console.log(`\nRetention — ${label}`);
  console.log('-'.repeat(52));
  for (const [ratio, watchRatio] of rows) {
    const pct = Math.round(Number(ratio) * 100);
    if (pct % 5 !== 0) continue;                              // every 5%
    const bar = '#'.repeat(Math.max(0, Math.round(Number(watchRatio) * 30)));
    console.log(`${String(pct).padStart(3)}%  ${(Number(watchRatio) * 100).toFixed(0).padStart(4)}%  ${bar}`);
  }

  const opening = rows.slice(0, 3).map(r => Number(r[1]));
  const lost = opening.length ? (1 - opening[opening.length - 1]) * 100 : 0;
  console.log('-'.repeat(52));
  console.log(`Hook: ${(100 - lost).toFixed(0)}% still watching after the opening seconds.`);
  console.log(lost > 30
    ? '  -> The hook is losing people. Rewrite the first line.\n'
    : '  -> The hook is holding. Later losses are pacing.\n');
}

async function main() {
  const args = process.argv.slice(2);
  const days = args.includes('--days') ? Number(args[args.indexOf('--days') + 1]) : 28;
  const analytics = google.youtubeAnalytics({ version: 'v2', auth: authorize() });

  if (args.includes('--retention')) {
    const jobId = args[args.indexOf('--retention') + 1];
    const ledger = JSON.parse(await fsp.readFile(LEDGER_PATH, 'utf8'));
    const entry = ledger[jobId];
    if (!entry) throw new Error(`no uploaded short called "${jobId}"`);
    await retention(analytics, entry.videoId, jobId);
    return;
  }

  logger.info(`Channel performance, last ${days} days`);
  await overview(analytics, days);
}

main().catch(error => {
  logger.error(`analytics failed: ${error.message}`);
  process.exit(1);
});
