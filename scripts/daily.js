#!/usr/bin/env node
/**
 * One day of shorts, every channel, start to finish.
 *
 *   node scripts/daily.js              # render + upload + publish
 *   node scripts/daily.js --dry-run    # show the plan, touch nothing
 *   node scripts/daily.js --per 1      # shorts per channel (default 2)
 *
 * Runs in GitHub Actions on a daily schedule (.github/workflows/daily-shorts.yml)
 * so the PC is only a dashboard. Works the same locally.
 *
 * Per channel, in priority order (Football Files first — it has the audience):
 *   1. anything already rendered but not uploaded counts toward today's share
 *   2. render Reddit shorts until the share is met, walking a list of subreddits
 *      because any one of them can come back empty (Apify is flaky, and
 *      r/soccer's top posts are mostly links, not stories)
 *   3. upload without subtitle tracks and publish
 *
 * QUOTA: all three channels share one Google project, 10,000 units a day.
 * An upload is 1,600 and a publish 50, so 6 shorts is the ceiling — hence
 * 2 per channel. Subtitle tracks (400 each) would halve that.
 *
 * State is the ledgers under state/<channel>/shorts/, committed back to the
 * repo after each run so tomorrow's run knows what is already posted.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

const CHANNELS = [
  {
    name: 'Football Files',
    dataRoot: 'state/football',
    tokens: 'tokens.json',
    subs: [['soccer', 'week'], ['football', 'week'], ['PremierLeague', 'week'], ['soccer', 'month'], ['football', 'month']],
    // Same news breaks as a separate post in every football subreddit; the
    // ledger only dedupes by post id. Extend via FOOTBALL_SKIP in .env.
    skip: process.env.FOOTBALL_SKIP || 'man city|manchester city|115 charges|mbapp|oman|klopp|pochettino'
  },
  {
    name: 'AFTER CACHE',
    dataRoot: 'state/aftercache',
    tokens: 'tokens.aftercache.json',
    subs: [['shortscarystories', 'week'], ['lostmedia', 'week'], ['maliciouscompliance', 'week'], ['lostmedia', 'month']]
  },
  {
    name: 'Viral Vault Clip',
    dataRoot: 'state/clips-channel',
    tokens: 'tokens.clips.json',
    subs: [['tifu', 'week'], ['AmItheAsshole', 'week'], ['pettyrevenge', 'week'], ['tifu', 'month']]
  }
];

const jobIdOf = (file) => path.basename(file, '.mp4').replace(/_short$/, '');

function ledger(ch) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, ch.dataRoot, 'shorts', 'uploads.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** Rendered shorts no ledger mentions — finished work waiting for quota. */
function pending(ch) {
  const dir = path.join(ROOT, ch.dataRoot, 'shorts', 'video');
  if (!fs.existsSync(dir)) return [];
  const known = ledger(ch);
  return fs.readdirSync(dir).filter((f) => /_short\.mp4$/.test(f)).map(jobIdOf).filter((id) => !known[id]);
}

function run(script, args, ch) {
  const res = spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    env: { ...process.env, DATA_ROOT: ch.dataRoot, YT_TOKENS_FILE: ch.tokens },
    encoding: 'utf8',
    timeout: 20 * 60 * 1000
  });
  process.stdout.write(`${res.stdout || ''}${res.stderr || ''}`);
  return res.status === 0;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const per = Number(args.includes('--per') ? args[args.indexOf('--per') + 1] : 2) || 2;
  const skipArgs = (ch) => (ch.skip ? ['--skip', ch.skip] : []);
  const summary = [];

  for (const ch of CHANNELS) {
    console.log(`\n=== ${ch.name} ===`);
    let waiting = pending(ch);
    console.log(`${waiting.length} rendered and waiting: ${waiting.join(', ') || '-'}`);

    // Render until today's share is met, trying each subreddit in turn.
    for (const [sub, period] of ch.subs) {
      if (waiting.length >= per) break;
      const need = String(per - waiting.length);
      console.log(`rendering ${need} from r/${sub} (${period})`);
      const common = ['--sub', sub, '--period', period, '--count', need, ...skipArgs(ch)];
      if (dryRun) {
        run('scripts/production/make-reddit-short.js', [...common, '--dry-run'], ch);
        break;
      }
      run('scripts/production/make-reddit-short.js', common, ch);
      waiting = pending(ch);
    }

    const toPost = waiting.slice(0, per);
    if (dryRun || !toPost.length) {
      summary.push(`${ch.name}: ${dryRun ? `would post ${toPost.length}` : 'nothing to post'}`);
      continue;
    }

    run('scripts/youtube/upload-shorts.js', ['--no-subs', '--limit', String(toPost.length)], ch);
    const uploaded = toPost.filter((id) => ledger(ch)[id]);
    if (uploaded.length) run('scripts/youtube/upload-shorts.js', ['--publish', ...uploaded], ch);

    const after = ledger(ch);
    const live = uploaded.filter((id) => after[id]?.privacyStatus === 'public');
    summary.push(`${ch.name}: ${live.length}/${toPost.length} public ${live.map((id) => after[id].url).join(' ')}`);
  }

  console.log('\n=== summary ===');
  summary.forEach((s) => console.log(s));
}

main();
