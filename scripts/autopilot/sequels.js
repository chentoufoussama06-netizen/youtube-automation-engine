/**
 * Which story short, if any, has earned a Part 2.
 *
 * Football Files, 28 days to 2026-10-30: 50 shorts, 2,379 views, ONE
 * subscriber. The top five took 80% of the views (John Terry alone 1,009 at
 * 81% watched, 0 subs) and most of the rest got under 15. A "Part 2" is the
 * one thing that gives a Shorts viewer a reason to follow a channel, but it
 * only borrows Part 1's audience: a sequel to a 9-view short reaches nobody.
 * So sequels are not planned up front — they go only to a short that has
 * already proved it can pull a crowd and hold it.
 *
 * A sequel replaces one of the lane's story shorts for the day rather than
 * adding to them, so it costs no extra upload quota.
 */

const fs = require('fs');
const path = require('path');
const { videoStats } = require('../../utils/short-stats');

const ROOT = path.join(__dirname, '..', '..');
const MIN_VIEWS = Number(process.env.SEQUEL_MIN_VIEWS) || 300;
const MIN_AVG_PCT = Number(process.env.SEQUEL_MIN_AVG_PCT) || 60;
// Analytics lags a day or two, so a short younger than this has no honest
// number yet; older than the max, its audience has moved on.
const MIN_AGE_DAYS = Number(process.env.SEQUEL_MIN_AGE_DAYS) || 2;
const MAX_AGE_DAYS = Number(process.env.SEQUEL_MAX_AGE_DAYS) || 21;
const MAX_PART = Number(process.env.SEQUEL_MAX_PART) || 3;
const MAX_FAILURES = 2;

const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return fb; } };

/**
 * The best-performing story of this lane that qualifies for its next part,
 * with its numbers and video id attached, or null.
 */
async function pickSequel(lane, st) {
  const base = (...p) => path.join(ROOT, lane.dataRoot, ...p);
  const stories = readJson(base('stories.json'), []);
  const ledger = readJson(base('shorts', 'uploads.json'), {});
  const continued = new Set(stories.map((s) => s.sequelOf).filter(Boolean));
  const now = Date.now();

  const candidates = stories.filter((s) => {
    const entry = ledger[s.id];
    if (!entry?.videoId || entry.privacyStatus !== 'public') return false;
    const age = (now - Date.parse(entry.publishedAt || entry.uploadedAt || s.at)) / 86400000;
    return age >= MIN_AGE_DAYS && age <= MAX_AGE_DAYS
      && (s.part || 1) < MAX_PART
      && !continued.has(s.id)
      && (st.failures[`sequel:${s.id}`] || 0) < MAX_FAILURES;
  });
  if (!candidates.length) return null;

  const since = new Date(now - (MAX_AGE_DAYS + 1) * 86400000);
  const stats = await videoStats(lane.tokens, candidates.map((s) => ledger[s.id].videoId), since);
  const winners = candidates
    .map((s) => ({ ...s, videoId: ledger[s.id].videoId, url: ledger[s.id].url, ...(stats.get(ledger[s.id].videoId) || { views: 0, avgPct: 0 }) }))
    .filter((s) => s.views >= MIN_VIEWS && s.avgPct >= MIN_AVG_PCT)
    .sort((a, b) => b.views - a.views);
  return winners[0] || null;
}

module.exports = { pickSequel, MIN_VIEWS, MIN_AVG_PCT, MAX_PART };
