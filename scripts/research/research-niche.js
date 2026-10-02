#!/usr/bin/env node
/* global fetch */
// fetch is a Node global from v18 onward and package.json already pins
// engines.node to >=18; declared because the shared eslint config predates it.
/**
 * The vidIQ half of the job, done against YouTube's own API.
 *
 *   node scripts/research-niche.js trending --country MA
 *   node scripts/research-niche.js trending --country US --category Sports
 *   node scripts/research-niche.js niche "football disaster documentary" --country GB
 *   node scripts/research-niche.js keywords "football documentary"
 *   node scripts/research-niche.js audit UCxxxxxxxx
 *   node scripts/research-niche.js categories --country MA
 *
 * What a paid research tool actually sells is three things: what is big in a
 * given country right now, which uploads beat their own channel's average
 * (the "outlier" — the only honest signal that a FORMAT worked rather than a
 * channel being large), and what people type into the search box. All three
 * come out of public endpoints, so this pays no subscription.
 *
 * Quota is the real currency here, not money. The daily allowance is 10,000
 * units against the whole Cloud project, an upload costs ~1,600 of it, and a
 * search costs 100 while everything else costs 1. So `trending` and `audit`
 * are near-free and `niche` is the expensive one — every run prints what it
 * spent. If research starts crowding out uploads, make a SECOND Google Cloud
 * project, put its API key in YOUTUBE_RESEARCH_KEY, and this file will use it;
 * quota is per project, so that genuinely doubles the allowance.
 *
 * Read-only. Nothing here can touch a video.
 */

require('dotenv').config();

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { google } = require('googleapis');
const { Logger } = require('../../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'data', 'research', 'niche');
const logger = new Logger('ResearchNiche');

// Quota costs, from the published table. Only search is expensive.
const COST = { search: 100, videos: 1, channels: 1, playlistItems: 1, videoCategories: 1 };
let spent = 0;
const charge = (kind) => { spent += COST[kind]; };

function client() {
  // A plain API key is preferred: it keeps research off the OAuth credential
  // and, if it belongs to another Cloud project, off the upload quota too.
  const key = process.env.YOUTUBE_RESEARCH_KEY || process.env.YOUTUBE_API_KEY;
  if (key) return google.youtube({ version: 'v3', auth: key });

  const creds = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'credentials.json'), 'utf8')).youtube;
  const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'tokens.json'), 'utf8')).youtube;
  const oauth = new google.auth.OAuth2(creds.client_id, creds.client_secret, (creds.redirect_uris || [])[0]);
  oauth.setCredentials(tokens);
  return google.youtube({ version: 'v3', auth: oauth });
}

// ── small helpers ───────────────────────────────────────────────────────────

const n = (x) => Number(x || 0);

function compact(x) {
  const v = n(x);
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(Math.round(v));
}

function durationSeconds(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '') || [];
  return n(m[1]) * 86400 + n(m[2]) * 3600 + n(m[3]) * 60 + n(m[4]);
}

function ageDays(iso) {
  return Math.max(0.05, (Date.now() - new Date(iso).getTime()) / 86400000);
}

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

function arg(args, flag, fallback = null) {
  const i = args.indexOf(flag);
  return i === -1 ? fallback : args[i + 1];
}

const region = (args) => (arg(args, '--country', process.env.YOUTUBE_REGION || 'US') || 'US').toUpperCase();
const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 60);

async function save(name, payload) {
  await fsp.mkdir(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${name}.json`);
  await fsp.writeFile(file, JSON.stringify(payload, null, 2));
  return file;
}

// ── channel stats, cached within a run ──────────────────────────────────────

const channelCache = new Map();

async function channelsById(yt, ids) {
  const missing = [...new Set(ids)].filter((id) => id && !channelCache.has(id));
  for (let i = 0; i < missing.length; i += 50) {
    const res = await yt.channels.list({
      part: 'snippet,statistics,contentDetails',
      id: missing.slice(i, i + 50).join(',')
    });
    charge('channels');
    for (const c of res.data.items || []) channelCache.set(c.id, c);
  }
  return ids.map((id) => channelCache.get(id)).filter(Boolean);
}

/**
 * The outlier score. A video's views divided by the median of its channel's
 * recent uploads: 1.0 is a normal day for that channel, 5.0 means the format
 * or the title did something the channel cannot normally do. This is the
 * number worth copying — raw view counts mostly measure subscriber count.
 */
async function channelBaseline(yt, channelId) {
  const [ch] = await channelsById(yt, [channelId]);
  if (!ch) return null;

  const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return { channel: ch, medianViews: 0, recent: [] };

  const list = await yt.playlistItems.list({ part: 'contentDetails', playlistId: uploads, maxResults: 20 });
  charge('playlistItems');
  const ids = (list.data.items || []).map((i) => i.contentDetails.videoId).filter(Boolean);
  if (!ids.length) return { channel: ch, medianViews: 0, recent: [] };

  const vids = await yt.videos.list({ part: 'snippet,statistics,contentDetails', id: ids.join(',') });
  charge('videos');
  const recent = (vids.data.items || []).map((v) => ({
    id: v.id,
    title: v.snippet.title,
    publishedAt: v.snippet.publishedAt,
    views: n(v.statistics.viewCount),
    likes: n(v.statistics.likeCount),
    comments: n(v.statistics.commentCount),
    seconds: durationSeconds(v.contentDetails.duration)
  })).sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  // Skip the newest two: they are still accumulating and would drag the
  // median down, inflating every outlier score computed against it.
  const settled = recent.slice(2).map((v) => v.views).filter((v) => v > 0);
  return { channel: ch, medianViews: median(settled.length ? settled : recent.map((v) => v.views)), recent };
}

// ── modes ───────────────────────────────────────────────────────────────────

/**
 * What is actually big in one country right now. This is YouTube's own
 * trending chart, one quota unit, and it is the closest thing to the country
 * leaderboards that research tools charge for.
 */
async function trending(yt, args) {
  const country = region(args);
  const wanted = arg(args, '--category');
  const limit = n(arg(args, '--limit', 25)) || 25;

  let categoryId;
  if (wanted) {
    const cats = await yt.videoCategories.list({ part: 'snippet', regionCode: country });
    charge('videoCategories');
    const hit = (cats.data.items || []).find((c) =>
      c.id === wanted || c.snippet.title.toLowerCase().includes(String(wanted).toLowerCase()));
    if (!hit) throw new Error(`No category matching "${wanted}" in ${country}. Run: categories --country ${country}`);
    categoryId = hit.id;
    logger.info(`Category: ${hit.snippet.title} (${hit.id})`);
  }

  const res = await yt.videos.list({
    part: 'snippet,statistics,contentDetails',
    chart: 'mostPopular',
    regionCode: country,
    videoCategoryId: categoryId,
    maxResults: Math.min(50, limit)
  });
  charge('videos');

  const items = res.data.items || [];
  if (!items.length) {
    logger.warn(`No trending chart returned for ${country}${categoryId ? ` in category ${categoryId}` : ''}.`);
    return [];
  }

  const chans = await channelsById(yt, items.map((v) => v.snippet.channelId));
  const subsOf = new Map(chans.map((c) => [c.id, n(c.statistics.subscriberCount)]));

  const rows = items.map((v, i) => {
    const views = n(v.statistics.viewCount);
    const subs = subsOf.get(v.snippet.channelId) || 0;
    return {
      rank: i + 1,
      videoId: v.id,
      title: v.snippet.title,
      channel: v.snippet.channelTitle,
      channelId: v.snippet.channelId,
      subs,
      views,
      viewsPerHour: Math.round(views / (ageDays(v.snippet.publishedAt) * 24)),
      // Views against channel size: >1 means it reached past the subscriber base.
      reach: subs ? +(views / subs).toFixed(2) : null,
      seconds: durationSeconds(v.contentDetails.duration),
      publishedAt: v.snippet.publishedAt,
      tags: v.snippet.tags || []
    };
  });

  console.log(`\nTrending in ${country}${categoryId ? ` · category ${categoryId}` : ''}\n`);
  console.log('   #   views     v/hr    reach   len  channel                 title');
  console.log('  ' + '-'.repeat(98));
  for (const r of rows.slice(0, limit)) {
    console.log('  '
      + String(r.rank).padStart(2) + ' '
      + compact(r.views).padStart(7) + ' '
      + compact(r.viewsPerHour).padStart(8) + ' '
      + (r.reach === null ? '-' : `${r.reach}x`).padStart(8) + ' '
      + `${Math.round(r.seconds)}s`.padStart(5) + '  '
      + r.channel.slice(0, 22).padEnd(23)
      + r.title.slice(0, 42));
  }

  const file = await save(`trending_${country}${categoryId ? `_${categoryId}` : ''}`, { country, categoryId, rows });
  logger.info(`Saved ${file}`);
  return rows;
}

/**
 * Search one niche and rank by outlier score rather than raw views, so a
 * 40k-view breakout on a 3k-subscriber channel outranks a 400k-view routine
 * upload from a giant. The small channel is the one whose format is copyable.
 */
async function niche(yt, args) {
  const phrase = args[1];
  if (!phrase || phrase.startsWith('--')) throw new Error('Give a search phrase: niche "football disaster documentary"');

  const country = region(args);
  const lang = arg(args, '--lang');
  const days = n(arg(args, '--days', 180)) || 180;
  const maxSubs = n(arg(args, '--max-subs', 0));
  const deep = n(arg(args, '--baselines', 12)) || 12;

  const search = await yt.search.list({
    part: 'snippet',
    q: phrase,
    type: 'video',
    regionCode: country,
    relevanceLanguage: lang || undefined,
    order: 'viewCount',
    publishedAfter: new Date(Date.now() - days * 86400000).toISOString(),
    maxResults: 50
  });
  charge('search');

  const ids = (search.data.items || []).map((i) => i.id?.videoId).filter(Boolean);
  if (!ids.length) {
    logger.warn(`Nothing found for "${phrase}" in ${country} within ${days} days.`);
    return [];
  }

  const vids = await yt.videos.list({ part: 'snippet,statistics,contentDetails', id: ids.join(',') });
  charge('videos');

  const chans = await channelsById(yt, (vids.data.items || []).map((v) => v.snippet.channelId));
  const byId = new Map(chans.map((c) => [c.id, c]));

  let rows = (vids.data.items || []).map((v) => {
    const subs = n(byId.get(v.snippet.channelId)?.statistics?.subscriberCount);
    const views = n(v.statistics.viewCount);
    return {
      videoId: v.id,
      title: v.snippet.title,
      channel: v.snippet.channelTitle,
      channelId: v.snippet.channelId,
      subs,
      views,
      likes: n(v.statistics.likeCount),
      comments: n(v.statistics.commentCount),
      seconds: durationSeconds(v.contentDetails.duration),
      publishedAt: v.snippet.publishedAt,
      viewsPerDay: Math.round(views / ageDays(v.snippet.publishedAt)),
      reach: subs ? +(views / subs).toFixed(2) : null,
      tags: v.snippet.tags || [],
      outlier: null
    };
  });

  if (maxSubs) rows = rows.filter((r) => r.subs && r.subs <= maxSubs);
  rows.sort((a, b) => (b.reach || 0) - (a.reach || 0));

  // Outlier scores cost two units each, so only buy them for the most
  // promising handful rather than for all fifty results.
  for (const r of rows.slice(0, deep)) {
    const base = await channelBaseline(yt, r.channelId).catch(() => null);
    if (base?.medianViews) r.outlier = +(r.views / base.medianViews).toFixed(1);
  }

  const ranked = [...rows].sort((a, b) => (b.outlier || 0) - (a.outlier || 0) || (b.reach || 0) - (a.reach || 0));

  console.log(`\n"${phrase}" · ${country} · last ${days}d · ranked by outlier, then reach\n`);
  console.log('  outlier    reach    views    subs    len  channel                title');
  console.log('  ' + '-'.repeat(104));
  for (const r of ranked.slice(0, 25)) {
    console.log('  '
      + (r.outlier ? `${r.outlier}x` : '-').padStart(7) + ' '
      + (r.reach === null ? '-' : `${r.reach}x`).padStart(8) + ' '
      + compact(r.views).padStart(8) + ' '
      + compact(r.subs).padStart(7) + ' '
      + `${Math.round(r.seconds)}s`.padStart(6) + '  '
      + r.channel.slice(0, 21).padEnd(22)
      + r.title.slice(0, 42));
  }

  const file = await save(`niche_${country}_${slug(phrase)}`, { phrase, country, days, rows: ranked });
  logger.info(`Saved ${file}`);
  return ranked;
}

/**
 * What people actually type. YouTube's own autocomplete is the same source the
 * paid keyword tools resell, it is public, and it costs zero quota — so this
 * expands a seed across the alphabet and the question words for free.
 */
async function keywords(yt, args) {
  const seed = args[1];
  if (!seed || seed.startsWith('--')) throw new Error('Give a seed phrase: keywords "football documentary"');
  const country = region(args);
  const compete = args.includes('--compete');

  const modifiers = ['', ...'abcdefghijklmnopqrstuvwxyz'.split(''),
    'how ', 'why ', 'what ', 'who ', 'when ', 'best ', 'worst ', 'story of '];

  const found = new Map();
  for (const mod of modifiers) {
    const q = mod.length === 1 ? `${seed} ${mod}` : `${mod}${seed}`;
    const url = 'https://suggestqueries.google.com/complete/search'
      + `?client=firefox&ds=yt&hl=en&gl=${country.toLowerCase()}&q=${encodeURIComponent(q)}`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) continue;
      const [, suggestions = []] = JSON.parse(await res.text());
      for (const s of suggestions) if (!found.has(s)) found.set(s, { term: s, from: q.trim() });
    } catch {
      // Autocomplete is best-effort; one dead request should not end the run.
    }
  }

  const terms = [...found.values()];
  if (!terms.length) {
    logger.warn('Autocomplete returned nothing — check the network, then retry.');
    return [];
  }

  console.log(`\n${terms.length} phrases people type around "${seed}" (${country})\n`);

  if (compete) {
    // One search per term at 100 units is the honest price of a competition
    // read, so it is opt-in and capped hard.
    const sample = terms.slice(0, n(arg(args, '--compete-limit', 8)) || 8);
    console.log('  competing   term');
    console.log('  ' + '-'.repeat(72));
    for (const t of sample) {
      const res = await yt.search.list({ part: 'id', q: t.term, type: 'video', regionCode: country, maxResults: 1 });
      charge('search');
      // totalResults is YouTube's own rough estimate. It is useful only to
      // compare one term against another — never quote it as a real number.
      t.competing = n(res.data.pageInfo?.totalResults);
      console.log('  ' + compact(t.competing).padStart(9) + '   ' + t.term);
    }
    console.log('\n  Lower = less already ranking for it. Comparative only, not a real count.');
  } else {
    for (const t of terms) console.log('  ' + t.term);
    console.log('\n  Add --compete to price the top few against how much already ranks for them.');
  }

  const file = await save(`keywords_${country}_${slug(seed)}`, { seed, country, terms });
  logger.info(`Saved ${file}`);
  return terms;
}

/** Everything one competitor is doing: cadence, lengths, what over-performs. */
async function audit(yt, args) {
  const raw = args[1];
  if (!raw || raw.startsWith('--')) throw new Error('Give a channel id, @handle or channel URL.');

  let channelId = (/channel\/(UC[\w-]+)/.exec(raw) || [])[1] || raw;
  const handle = /^@/.test(raw) ? raw : (/youtube\.com\/(@[\w.-]+)/.exec(raw) || [])[1];
  if (handle) {
    const res = await yt.channels.list({ part: 'id', forHandle: handle });
    charge('channels');
    channelId = res.data.items?.[0]?.id;
    if (!channelId) throw new Error(`No channel for handle ${handle}`);
  }

  const base = await channelBaseline(yt, channelId);
  if (!base) throw new Error(`Channel ${channelId} not found.`);
  const { channel: ch, medianViews, recent } = base;
  const s = ch.statistics;

  console.log(`\n${ch.snippet.title}`);
  console.log(`  ${compact(s.subscriberCount)} subs · ${compact(s.viewCount)} views · ${compact(s.videoCount)} videos`
    + ` · since ${ch.snippet.publishedAt.slice(0, 10)} · ${ch.snippet.country || 'country not set'}`);
  console.log(`  lifetime views per video: ${compact(n(s.viewCount) / Math.max(1, n(s.videoCount)))}`);

  if (recent.length > 1) {
    const span = (new Date(recent[0].publishedAt) - new Date(recent[recent.length - 1].publishedAt)) / (7 * 86400000);
    console.log(`  cadence: ${((recent.length - 1) / Math.max(0.5, span)).toFixed(1)} uploads/week over the last ${recent.length}`);
    console.log(`  median views on settled uploads: ${compact(medianViews)}`);
  }

  console.log('\n  outlier    views    len  published    title');
  console.log('  ' + '-'.repeat(94));
  for (const v of recent) {
    console.log('  '
      + (medianViews ? `${(v.views / medianViews).toFixed(1)}x` : '-').padStart(7) + ' '
      + compact(v.views).padStart(8) + ' '
      + `${Math.round(v.seconds)}s`.padStart(6) + '  '
      + v.publishedAt.slice(0, 10) + '   '
      + v.title.slice(0, 50));
  }

  const winners = recent.filter((v) => medianViews && v.views > medianViews * 1.5);
  if (winners.length) {
    console.log(`\n  ${winners.length} upload(s) beat their own median by 1.5x — those titles are the format worth reading:`);
    for (const w of winners) console.log(`    · ${w.title}`);
  }

  const file = await save(`audit_${channelId}`, { channelId, channel: ch.snippet.title, medianViews, recent });
  logger.info(`Saved ${file}`);
  return recent;
}

/**
 * Channels that did not exist a few weeks ago and are already pulling numbers.
 *
 * This is the only honest way to answer "what is working RIGHT NOW", because a
 * channel with no history and no subscriber base cannot be riding anything
 * except the format itself. An old channel's views are confounded by its
 * back catalogue; a three-week-old channel's are not.
 *
 * There is no endpoint that lists channels by age, so this goes the long way:
 * search the niche, collect whoever shows up, then throw away every channel
 * older than the cutoff.
 */
async function newcomers(yt, args) {
  const phrases = (args[1] && !args[1].startsWith('--') ? args[1] : '').split('|').map((s) => s.trim()).filter(Boolean);
  if (!phrases.length) throw new Error('Give one or more phrases: newcomers "football tragedy|football story"');

  const country = region(args);
  const maxAge = n(arg(args, '--max-age-days', 90)) || 90;
  const days = n(arg(args, '--days', 30)) || 30;
  const minViews = n(arg(args, '--min-views', 100000)) || 100000;

  const seen = new Map();
  for (const phrase of phrases) {
    const res = await yt.search.list({
      part: 'snippet',
      q: phrase,
      type: 'video',
      regionCode: country,
      order: 'viewCount',
      publishedAfter: new Date(Date.now() - days * 86400000).toISOString(),
      maxResults: 50
    });
    charge('search');
    for (const item of res.data.items || []) {
      const id = item.snippet?.channelId;
      if (id && !seen.has(id)) seen.set(id, { channelId: id, foundVia: phrase });
    }
  }

  if (!seen.size) {
    logger.warn('No channels matched those phrases in that window.');
    return [];
  }

  const chans = await channelsById(yt, [...seen.keys()]);
  const cutoff = Date.now() - maxAge * 86400000;

  const young = chans
    .filter((c) => new Date(c.snippet.publishedAt).getTime() >= cutoff)
    .map((c) => {
      const age = ageDays(c.snippet.publishedAt);
      const views = n(c.statistics.viewCount);
      return {
        channelId: c.id,
        title: c.snippet.title,
        country: c.snippet.country || '-',
        createdAt: c.snippet.publishedAt,
        ageDays: Math.round(age),
        subs: n(c.statistics.subscriberCount),
        views,
        videos: n(c.statistics.videoCount),
        viewsPerDay: Math.round(views / age),
        viewsPerVideo: Math.round(views / Math.max(1, n(c.statistics.videoCount))),
        uploadsPerWeek: +(n(c.statistics.videoCount) / (age / 7)).toFixed(1),
        foundVia: seen.get(c.id).foundVia
      };
    })
    .filter((c) => c.views >= minViews)
    .sort((a, b) => b.viewsPerDay - a.viewsPerDay);

  console.log(`\nChannels under ${maxAge} days old with ${compact(minViews)}+ views · ${country}`);
  console.log(`searched: ${phrases.join(' | ')}\n`);

  if (!young.length) {
    console.log(`  None. ${chans.length} channels showed up and every one is older than ${maxAge} days.`);
    console.log('  That itself is the finding: in this niche the winners are established, not new.\n');
  } else {
    console.log('   age    views   v/day   per-vid   subs  up/wk  channel');
    console.log('  ' + '-'.repeat(88));
    for (const c of young) {
      console.log('  '
        + `${c.ageDays}d`.padStart(5) + ' '
        + compact(c.views).padStart(8) + ' '
        + compact(c.viewsPerDay).padStart(7) + ' '
        + compact(c.viewsPerVideo).padStart(9) + ' '
        + compact(c.subs).padStart(6) + ' '
        + String(c.uploadsPerWeek).padStart(6) + '  '
        + c.title.slice(0, 34));
    }
    console.log(`\n  Next: audit the top one to see its actual uploads —`);
    console.log(`    node scripts/research-niche.js audit ${young[0].channelId}\n`);
  }

  const file = await save(`newcomers_${country}_${slug(phrases.join('-'))}`, { phrases, country, maxAge, days, young });
  logger.info(`Saved ${file}`);
  return young;
}

/** The category ids trending accepts, which differ by country. */
async function categories(yt, args) {
  const country = region(args);
  const res = await yt.videoCategories.list({ part: 'snippet', regionCode: country });
  charge('videoCategories');
  console.log(`\nCategories usable with --category in ${country}\n`);
  for (const c of res.data.items || []) {
    if (c.snippet.assignable === false) continue;
    console.log('  ' + c.id.padStart(3) + '  ' + c.snippet.title);
  }
  return res.data.items;
}

// ── entry ───────────────────────────────────────────────────────────────────

const MODES = { trending, niche, newcomers, keywords, audit, categories };

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];

  if (!mode || !MODES[mode]) {
    console.log(`
  node scripts/research-niche.js <mode> [...]

    trending   --country MA [--category Sports] [--limit 25]   what is big there now       ~2 units
    niche      "<phrase>" --country GB [--days 180]            breakouts in one topic     ~150 units
               [--max-subs 50000] [--baselines 12] [--lang en]
    newcomers  "<phrase|phrase>" --country US                  young channels already big ~110/phrase
               [--max-age-days 90] [--min-views 100000]
    keywords   "<seed>" [--country MA] [--compete]             what people type       0 (800 w/compete)
    audit      <channelId|@handle|url>                         one competitor, in full     ~4 units
    categories --country MA                                    category ids for trending    1 unit

  Daily quota is 10,000 units for the whole Cloud project and an upload costs ~1,600.
`);
    process.exit(1);
  }

  const yt = client();
  try {
    await MODES[mode](yt, args);
  } finally {
    // Only this run's spend is knowable here — the API exposes no "remaining
    // today" figure, so the upload comparison is a scale, not a balance.
    logger.info(`Quota spent this run: ${spent} units of the daily 10,000 `
      + `(one upload costs ~1,600).`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    logger.error(`research-niche failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { trending, niche, newcomers, keywords, audit, categories };
