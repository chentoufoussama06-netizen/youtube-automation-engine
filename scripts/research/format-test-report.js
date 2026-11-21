#!/usr/bin/env node
/**
 * How the format tests (lanes.js `test`) are doing against the ordinary
 * shorts on the same channel. Read-only: it never changes or posts anything.
 *
 *   node scripts/research/format-test-report.js                 # since 2026-11-21
 *   node scripts/research/format-test-report.js --since 2026-11-18
 *
 * Per short: public views (API key in ../youtube_api/api_key.txt) and, from
 * YouTube Analytics (each lane's own token), the stay rate (engagedViews /
 * views, the number that decides whether a short gets past the first batch)
 * and % watched. Analytics lags about two days, so young shorts show "-".
 * The state is read from cloud/main, where the daily runs commit it.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { google } = require('googleapis');
const { LANES } = require('../autopilot/lanes');

const ROOT = path.join(__dirname, '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const SINCE = arg('since', '2026-11-21');
const git = (a) => execSync(`git ${a}`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 << 20 });
const fromMain = (p, d) => { try { return JSON.parse(git(`show "cloud/main:${p}"`)); } catch { return d; } };
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

async function publicStats(ids) {
  const key = fs.readFileSync(path.join(ROOT, '..', 'youtube_api', 'api_key.txt'), 'utf8').trim();
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?${new URLSearchParams({ part: 'snippet,statistics', id: ids.slice(i, i + 50).join(',') })}`, { headers: { 'X-Goog-Api-Key': key } });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    for (const v of j.items || []) out.set(v.id, { views: Number(v.statistics.viewCount) || 0, at: v.snippet.publishedAt, title: v.snippet.title });
  }
  return out;
}

async function stayRates(lane, ids) {
  const creds = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'credentials.json'), 'utf8')).youtube;
  const oauth = new google.auth.OAuth2(creds.client_id, creds.client_secret, (creds.redirect_uris || [])[0]);
  oauth.setCredentials(JSON.parse(fs.readFileSync(path.join(ROOT, 'config', lane.tokens), 'utf8')).youtube);
  const yta = google.youtubeAnalytics({ version: 'v2', auth: oauth });
  const out = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const res = await yta.reports.query({
      ids: 'channel==MINE', startDate: SINCE, endDate: new Date().toISOString().slice(0, 10),
      metrics: 'views,engagedViews,averageViewPercentage', dimensions: 'video', filters: `video==${ids.slice(i, i + 100).join(',')}`, maxResults: 200
    });
    for (const [id, views, engaged, pct] of res.data.rows || []) out.set(id, { stay: views ? Math.round((100 * engaged) / views) : null, watched: Math.round(pct) });
  }
  return out;
}

(async () => {
  try { git('fetch -q cloud'); } catch { console.log('(could not fetch cloud; reading the last fetched state)'); }
  for (const lane of LANES.filter((l) => l.test)) {
    const stories = fromMain(`${lane.dataRoot}/stories.json`, []).filter((s) => String(s.at) >= SINCE);
    const ledger = fromMain(`${lane.dataRoot}/shorts/uploads.json`, {});
    const rows = stories.map((s) => ({ ...s, kind: s.variant || 'ordinary', videoId: ledger[s.id]?.videoId })).filter((s) => s.videoId);
    console.log(`\n=== ${lane.name}: test "${lane.test.name}" (${lane.test.perDay} a day) — ${rows.length} short(s) since ${SINCE}`);
    if (!rows.length) continue;
    const pub = await publicStats(rows.map((r) => r.videoId));
    const stay = await stayRates(lane, rows.map((r) => r.videoId)).catch((e) => { console.log(`  (no Analytics: ${String(e.message).slice(0, 100)})`); return new Map(); });
    for (const r of rows) {
      const p = pub.get(r.videoId) || {};
      const a = stay.get(r.videoId) || {};
      r.views = p.views ?? 0;
      r.hours = p.at ? (Date.now() - Date.parse(p.at)) / 36e5 : 0;
      r.stay = a.stay ?? null;
      console.log(`  ${r.kind === 'ordinary' ? '        ' : 'TEST    '}${String(r.at).slice(5, 16)} ${String(r.hours.toFixed(0)).padStart(4)}h ${String(r.views).padStart(7)} views  stayed ${a.stay == null ? '  -' : String(a.stay).padStart(3)}%  watched ${a.watched == null ? '  -' : String(a.watched).padStart(3)}%  ${String(p.title || r.title).slice(0, 70)}`);
    }
    for (const kind of [lane.test.name, 'ordinary']) {
      const settled = rows.filter((r) => r.kind === kind && r.hours >= 48);
      const stays = settled.map((r) => r.stay).filter((x) => x != null);
      console.log(`  ${kind.padEnd(10)} 48h+: n=${settled.length}  median views ${median(settled.map((r) => r.views)) ?? '-'}  best ${settled.length ? Math.max(...settled.map((r) => r.views)) : '-'}  median stay ${median(stays) ?? '-'}%  past 1,300: ${settled.filter((r) => r.views > 1300).length}`);
    }
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
