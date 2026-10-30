/**
 * Views and average-watched for a set of a channel's own videos, read from
 * YouTube Analytics with that channel's token.
 *
 * Analytics has its own quota, separate from the Data API's 10,000 units a
 * day that every upload draws on, so asking costs the channels nothing. It
 * lags publishing by a day or two, and a video nobody watched has no row at
 * all — both read here as "not a winner yet", never as an error.
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const ROOT = path.join(__dirname, '..');
const asDate = (d) => d.toISOString().slice(0, 10);   // the API wants YYYY-MM-DD

function analyticsFor(tokensFile) {
  const creds = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'credentials.json'), 'utf8')).youtube;
  const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', tokensFile), 'utf8')).youtube;
  const oauth = new google.auth.OAuth2(creds.client_id, creds.client_secret, (creds.redirect_uris || [])[0]);
  oauth.setCredentials(tokens);
  return google.youtubeAnalytics({ version: 'v2', auth: oauth });
}

/** Map of videoId -> { views, avgPct } since `since` (a Date). */
async function videoStats(tokensFile, videoIds, since) {
  const out = new Map();
  if (!videoIds.length) return out;
  const analytics = analyticsFor(tokensFile);
  // The video filter takes a comma-separated list of up to 500 ids.
  for (let i = 0; i < videoIds.length; i += 200) {
    const res = await analytics.reports.query({
      ids: 'channel==MINE',
      startDate: asDate(since),
      endDate: asDate(new Date()),
      metrics: 'views,averageViewPercentage',
      dimensions: 'video',
      filters: `video==${videoIds.slice(i, i + 200).join(',')}`
    });
    for (const [videoId, views, avgPct] of res.data.rows || []) {
      out.set(videoId, { views: Number(views), avgPct: Number(avgPct) });
    }
  }
  return out;
}

module.exports = { videoStats };
