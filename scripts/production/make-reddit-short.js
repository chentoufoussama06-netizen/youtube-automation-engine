#!/usr/bin/env node
/* global fetch, AbortSignal, clearTimeout */
/**
 * Reddit story on top, gameplay underneath — the format that actually travels.
 *
 *   node scripts/make-reddit-short.js --sub tifu
 *   node scripts/make-reddit-short.js --sub AmItheAsshole --count 3
 *   node scripts/make-reddit-short.js --sub tifu --dry-run     # pick stories, render nothing
 *
 * Everything heavy already exists: ShortsFactory renders the split layout, has
 * the gameplay window picker, and times captions to real word boundaries. The
 * only missing piece was a story source that is not a Wikipedia brief.
 *
 * WHY THIS IS NOT THE DOCUMENTARY PIPELINE. The source layer exists because a
 * documentary asserts facts about real disasters and real dead people, and
 * being wrong there is unforgivable. A Reddit post asserts nothing — it is one
 * person's account, presented as one person's account, credited to the thread
 * it came from. So there is no Wikidata pin, no claim extraction and no
 * approval gate here. What there IS: the story is read VERBATIM rather than
 * rewritten, so the engine cannot invent a detail the poster never wrote.
 *
 * Attribution is not optional. Every short records its permalink and
 * subreddit, and the description credits them.
 */

require('dotenv').config();

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { ShortsFactory } = require('../../utils/shorts-factory');
const { AIVideoGenerator } = require('../../utils/ai-video-generator');
const { Logger } = require('../../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const DATA_ROOT = process.env.DATA_ROOT || 'data';
const OUT = {
  video: path.join(ROOT, DATA_ROOT, 'shorts', 'video'),
  copy: path.join(ROOT, DATA_ROOT, 'shorts', 'copy'),
  audio: path.join(ROOT, DATA_ROOT, 'shorts', 'audio'),
  captions: path.join(ROOT, DATA_ROOT, 'shorts', 'captions')
};
const LEDGER_PATH = path.join(ROOT, DATA_ROOT, 'shorts', 'reddit.json');
const GAMEPLAY = path.join(ROOT, 'data', 'gameplay', 'gameplay-1080p.mp4');
const logger = new Logger('RedditShort');

const UA = 'youtube-automation-agent/1.0 (short-form story clips)';

/**
 * Ambient visuals for the top panel.
 *
 * Deliberately generic and deliberately fixed. Asking a model for per-story
 * visual queries costs an API call that is rate-limited on every free provider
 * right now, and the top panel in this format is atmosphere — nobody watches a
 * Reddit short for the b-roll. A fixed rotation also lands straight in the
 * Pexels cache that already holds 343 clips.
 */
const AMBIENT = [
  'city street at night', 'rain on window', 'person walking alone',
  'empty hallway', 'car driving at night', 'neon lights street',
  'coffee shop window', 'suburban street evening'
];

/**
 * Recurring threads that are not stories.
 *
 * r/soccer's top posts by upvotes are almost entirely Daily Discussion and
 * match threads — a wall of bullet points and links that narrates as nonsense.
 * The upvote count says they are popular; they are popular as a noticeboard.
 */
const NOT_A_STORY = /^\s*\[?(daily|weekly|monthly|match thread|post.?match|pre.?match|free talk|megathread|discussion thread|rate the|media thread|daily discussion)/i;

/** Strip Reddit markdown so the narrator does not read asterisks aloud. */
function clean(text) {
  return String(text || '')
    // Apify's actor returns "&39;" — a broken entity missing its #, which
    // survives normal unescaping and reaches the narrator as literal digits.
    .replace(/&#?(\d{2,4});?/g, (m, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links -> label
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_~`>#]/g, '')
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Expand the abbreviations these subreddits are built on. */
function expand(text) {
  return String(text)
    .replace(/\bTIFU\b/gi, 'Today I messed up')
    .replace(/\bAITA\b/gi, 'Am I the bad guy')
    .replace(/\bNTA\b/gi, 'not the bad guy')
    .replace(/\bYTA\b/gi, 'you are the bad guy')
    .replace(/\bOP\b/g, 'the poster')
    .replace(/\bIMO\b/gi, 'in my opinion')
    .replace(/\bTL;?DR\b/gi, 'In short');
}

/**
 * Trim to roughly `seconds` of speech on a sentence boundary.
 *
 * Cutting mid-sentence is what makes an auto-generated short sound broken, and
 * ~2.6 words a second is the measured rate of the voices this channel uses.
 */
function trimToSeconds(text, seconds = 55) {
  const budget = Math.round(seconds * 2.6);
  const sentences = String(text).match(/[^.!?]+[.!?]+/g) || [String(text)];
  const out = [];
  let words = 0;
  for (const s of sentences) {
    const n = s.trim().split(/\s+/).length;
    if (words + n > budget) break;
    out.push(s.trim());
    words += n;
  }
  return { text: out.join(' ') || sentences[0].trim(), words };
}

const unescapeHtml = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

/**
 * Stories from the subreddit's Atom feed.
 *
 * NOT the .json endpoint: Reddit now answers that with 403 for anything
 * without OAuth, browser User-Agent included — measured, not assumed. The RSS
 * feed still returns 200 and carries the whole post body inside
 * <content type="html">, which is all this needs. The trade is that RSS omits
 * scores, so `ups` is null and the feed's own ordering (top for the period)
 * is trusted instead of re-sorting.
 */
/**
 * Stories via Apify's Reddit scraper — the path that does not get blocked.
 *
 * Reddit answers the .json API with 403 and throttles the RSS feed within
 * seconds, both measured. Apify runs the scrape through residential proxies
 * and hands back the full body plus the numbers RSS omits: upVotes,
 * upVoteRatio, numberOfComments. That matters because engagement is the only
 * signal available for picking which story is worth 55 seconds of narration.
 *
 * Costs about $0.004 per post, so a 15-post pull is six cents.
 *
 * Deliberately the ASYNC api (start -> poll -> read dataset) rather than
 * run-sync: run-sync holds one connection open for the whole scrape and it was
 * dropping with "other side closed" every time.
 */
async function fetchStoriesApify(sub, { period = 'week', limit = 15 } = {}) {
  const token = process.env.APIFY_API_TOKEN;
  const base = 'https://api.apify.com/v2';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const started = await fetch(`${base}/acts/trudax~reddit-scraper-lite/runs?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startUrls: [{ url: `https://www.reddit.com/r/${sub}/top/?t=${period}` }],
      // Only the post bodies are needed; comments and user pages are billed per
      // result too, so skipping them is most of the cost saved.
      skipComments: true, skipUserPosts: true, skipCommunity: true,
      includeNSFW: false, maxItems: limit, maxPostCount: limit,
      sort: 'top', time: period,
      proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
    })
  });
  if (!started.ok) throw new Error(`Apify start failed: ${started.status}`);
  const run = (await started.json()).data;

  let status = run.status;
  for (let i = 0; i < 50 && !['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(status); i++) {
    await sleep(6000);
    const poll = await fetch(`${base}/actor-runs/${run.id}?token=${token}`);
    status = (await poll.json()).data.status;
  }
  if (status !== 'SUCCEEDED') throw new Error(`Apify run ${status}`);

  const ds = await fetch(`${base}/datasets/${run.defaultDatasetId}/items?token=${token}&limit=${limit}`);
  const items = await ds.json();

  return (Array.isArray(items) ? items : [])
    .filter((p) => p && p.title && p.body)
    .map((p) => ({
      id: p.parsedId ? String(p.parsedId).replace(/^t3_/, '') : String(p.id).replace(/^t3_/, ''),
      subreddit: p.parsedCommunityName || p.communityName || sub,
      title: clean(p.title),
      body: expand(clean(p.body)),
      ups: p.upVotes ?? null,
      permalink: p.url || p.link
    }))
    .filter((p) => !NOT_A_STORY.test(p.title))
    .filter((p) => p.body.length >= 400 && p.body.length <= 40000)
    .sort((a, b) => (b.ups ?? 0) - (a.ups ?? 0));
}

/** Apify when a token exists, Reddit's own feed when it does not. */
async function fetchStories(sub, opts = {}) {
  if (process.env.APIFY_API_TOKEN) {
    try {
      const viaApify = await fetchStoriesApify(sub, opts);
      if (viaApify.length) {
        logger.info(`r/${sub}: ${viaApify.length} story/stories via Apify`);
        return viaApify;
      }
      logger.warn(`r/${sub}: Apify returned nothing usable — falling back to RSS`);
    } catch (error) {
      logger.warn(`Apify scrape failed (${String(error.message).slice(0, 60)}) — falling back to RSS`);
    }
  }
  return fetchStoriesRss(sub, opts);
}

async function fetchStoriesRss(sub, { period = 'week' } = {}) {
  const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/top.rss?t=${period}`;
  const cacheDir = path.join(ROOT, 'data', 'cache');
  const cachePath = path.join(cacheDir, `reddit-${sub}-${period}.xml`);
  await fsp.mkdir(cacheDir, { recursive: true });

  // A dry run followed by a real run is two requests nineteen seconds apart,
  // and Reddit answers the second with 429. The feed barely changes in a
  // quarter of an hour, so it is cached and the backoff below covers the rest.
  let xml = null;
  const cached = await fsp.stat(cachePath).catch(() => null);
  if (cached && Date.now() - cached.mtimeMs < 15 * 60 * 1000) {
    xml = await fsp.readFile(cachePath, 'utf8');
    logger.info(`r/${sub}: reusing feed cached ${Math.round((Date.now() - cached.mtimeMs) / 1000)}s ago`);
  }

  for (let attempt = 1; !xml && attempt <= 4; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    if (res.ok) {
      xml = await res.text();
      await fsp.writeFile(cachePath, xml);
      break;
    }
    // 429 is a refusal to answer, not an empty subreddit.
    if (res.status !== 429 && res.status !== 503) throw new Error(`Reddit RSS HTTP ${res.status}`);
    if (attempt === 4) {
      if (cached) {
        logger.warn(`r/${sub}: throttled — falling back to the stale cached feed`);
        xml = await fsp.readFile(cachePath, 'utf8');
        break;
      }
      throw new Error(`Reddit RSS rate limited (HTTP ${res.status}) after ${attempt} attempts`);
    }
    const wait = 5000 * attempt;
    logger.warn(`Reddit ${res.status} — backing off ${wait / 1000}s (attempt ${attempt}/4)`);
    await new Promise((r) => setTimeout(r, wait));
  }

  const out = [];
  for (const entry of xml.match(/<entry>[\s\S]*?<\/entry>/g) || []) {
    const pick = (re) => (re.exec(entry) || [])[1] || '';
    const id = pick(/<id>t3_([a-z0-9]+)<\/id>/i);
    const link = pick(/<link[^>]+href="([^"]+)"/i);
    const title = clean(unescapeHtml(pick(/<title>([\s\S]*?)<\/title>/i)));
    // The body arrives as escaped HTML; unescape, then drop the markup.
    const html = unescapeHtml(pick(/<content[^>]*>([\s\S]*?)<\/content>/i));
    const body = expand(clean(html.replace(/<[^>]+>/g, ' ')));
    if (!id || !title || !body) continue;
    out.push({ id, subreddit: sub, title, body, ups: null, permalink: link });
  }

  // Long enough to be a story. The upper bound is deliberately huge because
  // trimToSeconds() already cuts to ~143 words: a 20,000-character r/nosleep
  // post simply becomes its first minute, which is the cliffhanger opening
  // that format wants. A 6,000 cap excluded every single nosleep story.
  return out.filter((p) => !NOT_A_STORY.test(p.title))
    .filter((p) => p.body.length >= 400 && p.body.length <= 40000);
}

const loadLedger = () => fsp.readFile(LEDGER_PATH, 'utf8').then(JSON.parse).catch(() => ({}));

async function buildOne(story, factory, generator, ledger) {
  const id = `reddit-${story.subreddit.toLowerCase()}-${story.id}`;
  if (ledger[id]) { logger.info(`${id} already built — skipping`); return null; }

  for (const d of Object.values(OUT)) await fsp.mkdir(d, { recursive: true });

  // Read as written. No rewrite step, so nothing can be invented.
  //
  // The TITLE is expanded here as well as the body: left raw, the narrator
  // spells "T-I-F-U" out letter by letter and the short sounds broken in its
  // first second. The stored YouTube title keeps the acronym, because that is
  // what people search for.
  const { text, words } = trimToSeconds(`${expand(story.title)}. ${story.body}`);
  await fsp.writeFile(path.join(OUT.copy, `${id}_short.txt`), text);

  const audioPath = path.join(OUT.audio, `${id}.mp3`);
  const voice = process.env.EDGE_TTS_VOICE || 'en-US-BrianNeural';
  const timed = await factory.narrateWithTiming(text, voice, audioPath);
  const seconds = await factory.probeDuration(audioPath);
  logger.info(`${id}: ${words} words -> ${seconds.toFixed(0)}s narration`);

  const captionPath = path.join(OUT.captions, `${id}.ass`);
  await fsp.writeFile(captionPath, factory.buildCaptions(timed.words || timed, {}));

  const wanted = Math.max(3, Math.min(6, Math.round(seconds / 8)));
  const storyClips = [];
  for (let i = 0; i < wanted; i++) {
    const query = AMBIENT[(i + story.id.charCodeAt(0)) % AMBIENT.length];
    try {
      const clip = await generator.fetchPexelsClipCached(query, 'portrait');
      if (clip) storyClips.push(clip);
    } catch (error) {
      logger.warn(`clip "${query}" failed: ${String(error.message).slice(0, 50)}`);
    }
  }
  if (!storyClips.length) throw new Error('no story clips could be sourced');

  let motionClip = null;
  let motionStart = 0;
  if (fs.existsSync(GAMEPLAY)) {
    try {
      motionStart = await factory.pickGameplayWindow(GAMEPLAY, seconds);
      motionClip = GAMEPLAY;
    } catch (error) {
      logger.warn(`gameplay unusable: ${String(error.message).slice(0, 60)}`);
    }
  }

  const outputPath = path.join(OUT.video, `${id}_short.mp4`);
  await factory.renderShort({
    storyClips, motionClip, motionStart, audioPath, captionPath, outputPath,
    layout: motionClip ? 'split' : 'full'
  });

  const stat = await fsp.stat(outputPath);
  logger.success(`${id}: ${Math.round(stat.size / 1048576)} MB, ${seconds.toFixed(0)}s -> ${outputPath}`);

  return {
    id,
    title: story.title.slice(0, 90),
    subreddit: story.subreddit,
    source: story.permalink,
    upvotes: story.ups,
    seconds: Math.round(seconds),
    renderedAt: new Date().toISOString()
  };
}

async function main() {
  const args = process.argv.slice(2);
  const get = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
  const sub = get('--sub', 'tifu');
  const count = Number(get('--count', '1')) || 1;
  const dryRun = args.includes('--dry-run');

  // --skip "man city|mbappe": drop stories on a subject a channel already
  // covered. The ledger only dedupes by post id, and the same news breaks as a
  // different post in every football subreddit.
  const skip = get('--skip') ? new RegExp(get('--skip'), 'i') : null;
  const stories = (await fetchStories(sub, { period: get('--period', 'week') }))
    .filter((s) => !skip || !skip.test(`${s.title} ${s.body}`));
  logger.info(`r/${sub}: ${stories.length} usable story/stories`);
  if (!stories.length) throw new Error(`no usable stories in r/${sub}`);

  if (dryRun) {
    for (const s of stories.slice(0, count)) {
      const { words } = trimToSeconds(`${s.title}. ${s.body}`);
      logger.info(`  ${String(words).padStart(3)}w  ${s.title.slice(0, 66)}`);
      logger.info(`     ${s.permalink}`);
    }
    return null;
  }

  const factory = new ShortsFactory({});
  const generator = new AIVideoGenerator({});
  const ledger = await loadLedger();
  const made = [];

  for (const story of stories) {
    if (made.length >= count) break;
    try {
      const entry = await buildOne(story, factory, generator, ledger);
      if (!entry) continue;
      ledger[entry.id] = entry;
      // Written per story: a crash on story 3 must not cost stories 1 and 2.
      await fsp.writeFile(LEDGER_PATH, JSON.stringify(ledger, null, 2));
      made.push(entry);
    } catch (error) {
      logger.warn(`${story.id} failed: ${String(error.message).slice(0, 90)}`);
    }
  }

  logger.info('');
  logger.success(`${made.length} short(s) built from r/${sub}`);
  for (const m of made) logger.info(`  ${m.id}  ${m.seconds}s  ${m.title.slice(0, 54)}`);
  if (made.length) {
    logger.info('');
    logger.info('Upload with: node scripts/upload-shorts.js --limit 3');
    logger.info('Credit the source subreddit in every description.');
  }
  return made;
}

if (require.main === module) {
  main().catch((error) => {
    logger.error(`make-reddit-short failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { fetchStories, fetchStoriesApify, fetchStoriesRss, trimToSeconds, clean, expand };
