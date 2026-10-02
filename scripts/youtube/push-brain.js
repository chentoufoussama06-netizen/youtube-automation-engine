#!/usr/bin/env node
/**
 * Tell WHOP OS (the second brain) what the engine has made and where it stands.
 *
 *   node scripts/youtube/push-brain.js            # push every channel
 *   node scripts/youtube/push-brain.js --dry-run  # print what would be pushed
 *
 * One row per video in WHOP OS's pipeline_items table, keyed (channel, job_id):
 *   public / unlisted / private — straight from each upload ledger
 *   held                        — rendered, deliberately parked in shorts/held/
 *   rendered                    — a finished short in shorts/video/ that no
 *                                 ledger mentions, i.e. never uploaded
 *
 * This is what lets the WHOP OS analyst answer "what is still not posted" and
 * "why is half the channel unlisted" instead of only "what performed".
 *
 * Reads local files only — no YouTube calls, no quota. Safe to run any time;
 * rows are upserted, so a rerun just refreshes them.
 *
 * The data folders were moved into ../_archive-2026-09-28 on 2026-09-28, so
 * each channel falls back to the archive copy when the live one is gone.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Logger } = require('../../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const ARCHIVE = path.join(ROOT, '..', '_archive-2026-09-28');
const logger = new Logger('PushBrain');

// state/ is the live, git-committed ledger (daily.js + GitHub Actions); the
// data/ paths and the archive are older homes, checked only as fallbacks.
const CHANNELS = {
  'Football Files': ['state/football/shorts', 'data/shorts'],
  'AFTER CACHE': ['state/aftercache/shorts', 'data/aftercache/shorts'],
  'Clips channel': ['state/clips-channel/shorts', 'data/clips-channel/shorts']
};

function shortsDir(rels) {
  for (const rel of rels) {
    for (const base of [ROOT, ARCHIVE]) {
      const dir = path.join(base, rel);
      if (fs.existsSync(path.join(dir, 'uploads.json'))) return dir;
    }
  }
  return null;
}

// "reddit-tifu-1wj9u3f_short.mp4" -> "reddit-tifu-1wj9u3f"
const jobIdOf = (file) => path.basename(file, path.extname(file)).replace(/(_short|_final|-final|_vertical)$/, '');

function collect() {
  const rows = [];
  for (const [channel, rel] of Object.entries(CHANNELS)) {
    const dir = shortsDir(rel);
    if (!dir) {
      logger.warn(`${channel}: no uploads.json found, skipping`);
      continue;
    }

    const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'uploads.json'), 'utf8'));
    for (const [jobId, e] of Object.entries(ledger)) {
      rows.push({
        channel, jobId,
        title: e.title || null,
        status: e.missingOnYouTube ? 'removed' : (e.privacyStatus || 'unknown'),
        videoId: e.videoId || null,
        url: e.url || null,
        scheduledAt: e.scheduledPublishAt || null
      });
    }

    const known = new Set(Object.keys(ledger));
    const listed = (sub) => (fs.existsSync(path.join(dir, sub)) ? fs.readdirSync(path.join(dir, sub)) : []);

    for (const f of listed('held')) {
      const jobId = jobIdOf(f);
      if (!known.has(jobId)) { known.add(jobId); rows.push({ channel, jobId, title: null, status: 'held' }); }
    }
    for (const f of listed('video').filter((n) => n.endsWith('.mp4'))) {
      const jobId = jobIdOf(f);
      if (!known.has(jobId)) { known.add(jobId); rows.push({ channel, jobId, title: null, status: 'rendered' }); }
    }
  }
  return rows;
}

async function main() {
  const rows = collect();
  const tally = rows.reduce((t, r) => ({ ...t, [`${r.channel} ${r.status}`]: (t[`${r.channel} ${r.status}`] || 0) + 1 }), {});
  for (const [k, n] of Object.entries(tally)) logger.info(`${k}: ${n}`);

  if (process.argv.includes('--dry-run')) return;
  if (!process.env.WHOP_OS_DATABASE_URL) throw new Error('WHOP_OS_DATABASE_URL is not set — nothing to write to.');

  const postgres = require('postgres');
  const sql = postgres(process.env.WHOP_OS_DATABASE_URL, { ssl: 'require', max: 1, connect_timeout: 15 });
  try {
    // Same DDL as WHOP OS lib/brain.ts, so either side can create it first.
    await sql`
      create table if not exists pipeline_items (
        channel text not null, job_id text not null, title text, status text not null,
        video_id text, url text, scheduled_at timestamptz,
        updated_at timestamptz not null default now(),
        primary key (channel, job_id)
      )`;
    for (const r of rows) {
      await sql`
        insert into pipeline_items (channel, job_id, title, status, video_id, url, scheduled_at, updated_at)
        values (${r.channel}, ${r.jobId}, ${r.title}, ${r.status}, ${r.videoId || null},
                ${r.url || null}, ${r.scheduledAt || null}, now())
        on conflict (channel, job_id) do update
          set title = coalesce(excluded.title, pipeline_items.title), status = excluded.status,
              video_id = excluded.video_id, url = excluded.url,
              scheduled_at = excluded.scheduled_at, updated_at = now()`;
    }
    logger.success(`${rows.length} pipeline item(s) -> WHOP OS brain`);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

main().catch((error) => {
  logger.error(`push-brain failed: ${error.message}`);
  process.exit(1);
});
