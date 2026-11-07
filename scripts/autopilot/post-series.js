#!/usr/bin/env node
/**
 * Post a whole planned series at once from renders already made and watched
 * (the preview-short.yml artifact): Part 1 goes public now, every later part
 * is uploaded private and scheduled one a day.
 *
 *   node scripts/autopilot/post-series.js "Football Files" de-la-fuente --from preview/ --at 17:00
 *   ... --dry-run    # say what would happen, upload nothing
 *
 * The schedule is this repo's own `scheduledPublishAt` on the ledger, not
 * YouTube's publishAt (see schedule-shorts.js for why): each autopilot run
 * publishes whatever is due (check-scheduled.js), so a part can still be
 * stopped before it goes out by deleting its scheduledPublishAt.
 *
 * Each part's "◀ Part n-1" line carries a placeholder in a preview; it gets
 * the real link here, once Part n-1 has a video id. The "▶ Part n" link and
 * the playlist come from the autopilot's linkSeries, held until the part is
 * public so no description ever points at a private video.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { LANES } = require('./lanes');
const { SERIES, partId } = require('./series');

const ROOT = path.join(__dirname, '..', '..');
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch { return fb; } };
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));

function main() {
  const args = process.argv.slice(2);
  const opt = (n, d = null) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
  const [laneName, key] = args.filter((a, i) => !a.startsWith('--') && !['--from', '--at'].includes(args[i - 1]));
  const dryRun = args.includes('--dry-run');
  const from = path.resolve(opt('--from', 'preview'));
  const at = opt('--at', '17:00');

  const lane = LANES.find((l) => l.name.toLowerCase() === String(laneName).toLowerCase());
  const series = SERIES.find((s) => s.key === key);
  if (!lane || !series) throw new Error(`usage: post-series.js "<lane>" <series key> --from <dir> --at HH:MM (lane "${laneName}", series "${key}")`);
  if (!/^\d{1,2}:\d{2}$/.test(at)) throw new Error(`--at must be HH:MM (UTC), got "${at}"`);

  const base = (...p) => path.join(ROOT, lane.dataRoot, ...p);
  const env = { ...process.env, DATA_ROOT: lane.dataRoot, QUEUE_PATH: base('queue.json'), YT_TOKENS_FILE: lane.tokens, CATEGORY_ID: lane.categoryId };
  const node = (script, scriptArgs) => {
    console.log(`$ node ${script} ${scriptArgs.join(' ')}`);
    const res = spawnSync(process.execPath, [path.join(ROOT, script), ...scriptArgs], { cwd: ROOT, env, encoding: 'utf8', timeout: 20 * 60 * 1000 });
    process.stdout.write(`${res.stdout || ''}${res.stderr || ''}`);
    return res.status === 0;
  };

  // Day n-1 after today at --at (UTC); Part 1 is now.
  const [hh, mm] = at.split(':').map(Number);
  const slot = (n) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + (n - 1));
    d.setUTCHours(hh, mm, 0, 0);
    return d.toISOString();
  };

  // Everything must be there before anything goes up: a series with a hole in
  // the middle is worse than no series.
  const of = series.parts.length;
  for (let n = 1; n <= of; n++) {
    const id = partId(series, n);
    for (const f of [`${id}_short.mp4`, `${id}_short.txt`]) {
      if (!fs.existsSync(path.join(from, f))) throw new Error(`missing ${f} in ${from}: render every part first`);
    }
  }

  const stPath = base('autopilot.json');
  const st = readJson(stPath, {});
  st.history = st.history || [];
  const ledgerPath = base('shorts', 'uploads.json');
  for (const dir of [base('shorts', 'video'), base('shorts', 'copy')]) fs.mkdirSync(dir, { recursive: true });

  let prev = null;
  for (let n = 1; n <= of; n++) {
    const part = series.parts[n - 1];
    const id = partId(series, n);
    const title = `${part.title} (Part ${n})`.slice(0, 90);
    const when = n === 1 ? 'now' : slot(n);
    let ledger = readJson(ledgerPath, {});
    if (ledger[id]?.videoId) {
      console.log(`${id}: already uploaded (${ledger[id].url}); keeping it`);
      prev = { id, videoId: ledger[id].videoId };
      continue;
    }

    let copy = fs.readFileSync(path.join(from, `${id}_short.txt`), 'utf8');
    if (prev) copy = copy.replace(/^◀ Part \d+: \S+/, `◀ Part ${n - 1}: https://youtube.com/shorts/${prev.videoId}`);
    console.log(`${id}: "${title}" -> ${when}`);
    if (dryRun) { prev = { id, videoId: `DRY${n}` }; continue; }

    fs.copyFileSync(path.join(from, `${id}_short.mp4`), base('shorts', 'video', `${id}_short.mp4`));
    fs.writeFileSync(base('shorts', 'copy', `${id}_short.txt`), copy);

    const queue = readJson(base('queue.json'), { topics: [] });
    queue.topics = queue.topics.filter((t) => t.id !== id);
    queue.topics.push({ id, topic: part.moment, keywords: [part.subject, series.name, ...(lane.story?.tags || [])].slice(0, 15),
      status: 'short', shortTitle: title, article: part.articles[0], categoryId: lane.categoryId });
    writeJson(base('queue.json'), queue);

    if (!node('scripts/youtube/upload-shorts.js', ['--no-subs', '--limit', '1'])) throw new Error(`${id}: upload failed`);
    ledger = readJson(ledgerPath, {});
    if (!ledger[id]?.videoId) throw new Error(`${id}: upload left no ledger entry`);

    if (n === 1) {
      if (!node('scripts/youtube/upload-shorts.js', ['--publish', id])) throw new Error(`${id}: publish failed`);
      st.history.push({ at: new Date().toISOString(), event: 'series', id, url: ledger[id].url });
    } else {
      ledger[id].scheduledPublishAt = when;
      writeJson(ledgerPath, ledger);
      st.history.push({ at: new Date().toISOString(), event: 'scheduled', id, url: ledger[id].url, publishAt: when });
      st.pendingLinks = st.pendingLinks || [];
      st.pendingLinks.push({ root: partId(series, 1), prev: prev.videoId, next: ledger[id].videoId, part: n, subject: series.name, after: when });
    }

    const stories = readJson(base('stories.json'), []);
    stories.push({ id, subject: part.subject, article: part.articles[0], moment: part.moment, title, at: new Date().toISOString(),
      style: 'v2', series: series.key, part: n, of, root: partId(series, 1), ...(prev ? { sequelOf: prev.id } : {}) });
    writeJson(base('stories.json'), stories);
    writeJson(stPath, st);
    console.log(`${id}: ${n === 1 ? 'PUBLIC' : `scheduled ${when}`} ${ledger[id].url}`);
    prev = { id, videoId: ledger[id].videoId };
  }
}

try {
  main();
} catch (error) {
  console.error(`post-series failed: ${error.message}`);
  process.exit(1);
}
