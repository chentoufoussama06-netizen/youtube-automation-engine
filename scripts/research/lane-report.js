#!/usr/bin/env node
/**
 * LANE REPORT — the publish-side digest for lane schema v3.
 *
 *   node scripts/lane-report.js
 *   node scripts/lane-report.js --days 28
 *
 * Reports views, retention and subs-per-1K per lane, and states where the
 * sport_wide experiment stands against its stopping rule.
 *
 * The stopping rule is the point. sport_wide is capped at 1 in 5 uploads, and
 * at roughly 30 uploads it either beats football on views AND holds 45%
 * retention — in which case the lane widens — or it is cut. Before that
 * threshold this refuses to render a verdict, because a number offered early
 * is an invitation to argue the lane instead of measuring it.
 *
 * Retention is averaged per video rather than weighted by views. The question
 * is whether the LANE holds an audience; letting one outlier's watch time carry
 * the average is how a single lucky video keeps a dead lane alive.
 */

require('dotenv').config();

const fsp = require('fs').promises;
const path = require('path');
const { laneOf, laneStats, laneVerdict, REVIEW_AT_UPLOADS, SPORT_WIDE_WINDOW } = require('../../utils/lanes');
const { Logger } = require('../../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const DATA_ROOT = process.env.DATA_ROOT || 'data';
const QUEUE_PATH = path.join(ROOT, DATA_ROOT, 'queue.json');
const LEDGER_PATH = path.join(ROOT, DATA_ROOT, 'shorts', 'uploads.json');
const logger = new Logger('LaneReport');

function db() {
  const url = process.env.WHOP_OS_DATABASE_URL;
  if (!url) throw new Error('WHOP_OS_DATABASE_URL is not set — no analytics to read.');
  return require('postgres')(url, { ssl: 'require', max: 1, connect_timeout: 15 });
}

const pct = (v) => (v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`);
const per1k = (v) => (v === null || v === undefined ? 'n/a' : v.toFixed(2));

async function main() {
  const args = process.argv.slice(2);
  const days = Number(args.includes('--days') ? args[args.indexOf('--days') + 1] : 28) || 28;

  const queue = JSON.parse(await fsp.readFile(QUEUE_PATH, 'utf8'));
  const ledger = await fsp.readFile(LEDGER_PATH, 'utf8').then(JSON.parse).catch(() => ({}));

  // topicId -> lane, then videoId -> lane through the upload ledger. A video
  // whose topic has left the queue keeps the default lane rather than dropping
  // out of the count, because it still went out on the channel.
  const laneByTopic = new Map(queue.topics.map((t) => [t.id, laneOf(t)]));
  const laneByVideo = new Map();
  for (const [topicId, entry] of Object.entries(ledger)) {
    if (entry?.videoId) laneByVideo.set(entry.videoId, laneByTopic.get(topicId) || laneOf(null));
  }
  if (!laneByVideo.size) throw new Error('no uploaded videos in the ledger yet — nothing to report.');

  const sql = db();
  let rows;
  try {
    // Newest snapshot per video for the requested window.
    rows = await sql`
      select distinct on (video_id)
        video_id, title, views, avg_view_percentage, subscribers_gained, captured_at
      from video_analytics
      where period_days = ${days} and video_id in ${sql([...laneByVideo.keys()])}
      order by video_id, captured_at desc
    `;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }

  const videos = rows.map((r) => ({
    lane: laneByVideo.get(r.video_id),
    title: r.title,
    views: Number(r.views) || 0,
    averageViewPercentage: Number(r.avg_view_percentage),
    subscribersGained: Number(r.subscribers_gained) || 0
  }));

  const stats = laneStats(videos);
  const verdict = laneVerdict(stats);

  logger.info(`lane report — ${videos.length} video(s) with ${days}-day analytics`);
  logger.info('');
  logger.info('  lane         uploads      views   avg views   retention   subs/1K   subs');
  for (const [lane, s] of Object.entries(stats)) {
    logger.info(`  ${lane.padEnd(12)} ${String(s.uploads).padStart(5)} `
      + `${String(s.views).padStart(10)} ${String(s.avgViews).padStart(11)} `
      + `${pct(s.retention).padStart(11)} ${per1k(s.subsPer1k).padStart(9)} ${String(s.subsGained).padStart(6)}`);
  }

  logger.info('');
  if (!verdict.decided) {
    logger.info(`Verdict: PENDING — ${verdict.uploads}/${REVIEW_AT_UPLOADS} uploads measured, `
      + `${verdict.remaining} to go. No decision before the threshold, by rule.`);
  } else {
    logger.warn(`Verdict at ${verdict.uploads} uploads: ${verdict.verdict.toUpperCase()}`);
    logger.info(`  ${verdict.detail}`);
    logger.info(`  beats football on views: ${verdict.beatsOnViews} · holds the retention bar: ${verdict.holdsRetention}`);
  }

  const missing = [...laneByVideo.keys()].filter((v) => !rows.some((r) => r.video_id === v));
  if (missing.length) {
    logger.info('');
    logger.info(`${missing.length} uploaded video(s) have no ${days}-day analytics row yet — `
      + 'run sync-dashboard.js, or they are too recent to have one.');
  }
  logger.info('');
  logger.info(`sport_wide stays capped at 1 in ${SPORT_WIDE_WINDOW} uploads until this verdict says otherwise.`);
  return { stats, verdict };
}

if (require.main === module) {
  main().catch((error) => {
    logger.error(`lane-report failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { main };
