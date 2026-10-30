#!/usr/bin/env node
/**
 * A 20-50s story short about one dramatic, documented moment (each lane's
 * story.words sets the length).
 *
 *   node scripts/autopilot/story-short.js "Football Files"            # make one
 *   node scripts/autopilot/story-short.js "Football Files" --dry-run  # pick + write, render nothing
 *   node scripts/autopilot/story-short.js "Football Files" --sequel <story id> --dry-run   # its next part
 *   node scripts/autopilot/story-short.js "Football Files" --article "Harry Kane" \
 *     --moment "On 26 October 2026 Kane won the Ballon d'Or." --title "Why Harry Kane Won the Ballon d'Or"
 *
 * Why this format. Measured 2026-10-07 across ~2,000 recent videos in 30
 * niches: the fastest-growing young football channel, GOATED90 (created
 * Nov 2025, 130K subs, 351M views), posts one story every day or two, every
 * one 2:30-3:00 long, every one about a FAMOUS name at a dramatic turn —
 * "When Balotelli Completely Lost His Mind 😭🔥" 4.4M, "The Ronaldo Comeback
 * Nobody Was Ready For" 2.0M, "The Man Who DESTROYED the Galácticos 💀" 1.1M.
 * PureGrit (NFL, 154K subs) is the same shape at 45-60s. This channel had been
 * making the opposite: 45s shorts about obscure subjects (Scarborough F.C.).
 *
 * What stays from this repo's rules: every fact comes from the Wikipedia
 * article the story is verified against, never from model memory, and every
 * picture is a Commons photo of the subject, credited in the description.
 */

require('dotenv').config();

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const axios = require('axios');
const { AITextService } = require('../../utils/ai-text-service');
const { ResearchService } = require('../../utils/research-service');
const { ArchivalImageService } = require('../../utils/archival-images');
const { ShortsFactory } = require('../../utils/shorts-factory');
const { Logger } = require('../../utils/logger');
const { LANES } = require('./lanes');
const { footballNews } = require('../../utils/news-feed');
const { renderStoryV2 } = require('../../utils/short-style-v2');

const ROOT = path.join(__dirname, '..', '..');
const logger = new Logger('StoryShort');

// ~1:50-2:55 at Edge TTS pace; a lane can set its own via story.words.
const DEFAULT_WORDS = { min: 250, target: 360, max: 420 };
// A cut every ~3.5s: at 20-50s, 6s holds left a short with four slow stills.
const SECONDS_PER_IMAGE = 3.5;

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const slug = (s, max = 30) => fold(s).replace(/\([^)]*\)/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, max).replace(/-$/, '');
const words = (t) => String(t).trim().split(/\s+/).filter(Boolean).length;
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return fb; } };

function parseJson(raw) {
  const text = String(raw || '').replace(/```(?:json)?/gi, '');
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s === -1 || e <= s) throw new Error('no JSON in reply');
  return JSON.parse(text.slice(s, e + 1));
}

// What each lane's stories are about. A lane without its own `story` block in
// lanes.js gets the football brief, which is where this format was measured.
const DEFAULT_STORY = {
  examples: [
    'When Balotelli Completely Lost His Mind 😭🔥  (4.4M)',
    'The Ronaldo Comeback Nobody Was Ready For 😭🔥  (2.0M)',
    'How Did Ronaldo Even Do This 😭🔥  (1.5M)',
    'Football Gave Torres the SAME Chance Twice  (1.2M)',
    'The Man Who DESTROYED the Galácticos 💀  (1.1M)',
    'The Champions League Run That Made ZERO Sense 😭🔥  (1.0M)',
    'When Karma DESTROYED an Entire National Team 😭🔥  (0.7M)'
  ],
  scope: 'About a FAMOUS footballer, manager, club or national team that casual fans\n'
    + '  worldwide know. Not obscure lower-league subjects.\n'
    + '- One specific, dramatic episode with an arc: meltdown, betrayal, impossible\n'
    + '  comeback, karma, redemption, rivalry turning into war, a season that made no\n'
    + '  sense, a career that collapsed, a disappearance.',
  captionExample: 'Mario Balotelli',
  tags: ['football', 'football story']
};

/**
 * What the world looked up on Wikipedia yesterday — the cheapest honest signal
 * of what people care about today. A story about a name people are already
 * searching gets pushed by search and the Shorts feed's freshness; a 1995
 * Cantona story competes with everything. Never fatal: [] on any failure.
 */
async function trending(limit = 150) {
  const d = new Date(Date.now() - 86400000);
  const ymd = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
  try {
    const { data: json } = await axios.get(`https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${ymd}`, {
      headers: { 'User-Agent': 'youtube-automation-engine/1.0 (autopilot trending check)' },
      timeout: 15000
    });
    return (json.items?.[0]?.articles || [])
      .map((a) => a.article.replace(/_/g, ' '))
      .filter((t) => !/^(Main Page|Special:|Wikipedia:|Portal:|File:|Help:|Talk:|Category:|Template:|Deaths in |List of |\d{4} in )/.test(t))
      .slice(0, limit);
  } catch {
    return [];
  }
}

async function propose(ai, lane, avoid, hot = [], news = []) {
  const story = lane.story || DEFAULT_STORY;
  const prompt = `You pick stories for the YouTube Shorts channel "${lane.name}".

The format that is winning right now (titles and views from young channels):
${story.examples.map((e) => `- ${e}`).join('\n')}
${news.length ? `
IN THE NEWS — this channel's headlines from the last two days. A story about
one of these beats any old one (Kane's Ballon d'Or, posted the morning after,
outran every short before it) — but ONLY if the episode is already written up
in the subject's English Wikipedia article, because it will be checked there:
${news.map((n) => `- ${n.title} (${n.outlet})`).join('\n')}
` : ''}${hot.length ? `
TRENDING — yesterday's most-read English Wikipedia articles, i.e. what people are
searching for right now. If any of these fits this channel's scope (a person,
club, event or thing it would cover), make your FIRST proposals about them:
${hot.join(' | ')}
` : ''}
Propose 10 stories like these. Rules:
- ${story.scope}
- It must be documented in that subject's English Wikipedia article.
- "article": the EXACT English Wikipedia article title of the person, event or thing.
- "subject": the name a photo caption would use (e.g. "${story.captionExample}"), no parentheses.
- "moment": one sentence naming the episode, with its year.
- "title": under 55 characters, states the shocking fact or twist in plain words,
  curiosity gap. Usually NO emoji; at most ONE, and only where it truly fits.
  Capitalise like the examples. Never promise something the article cannot back.
- Do NOT reuse anything already posted:
${avoid.map((t) => `  - ${t}`).join('\n') || '  (nothing yet)'}

Return ONLY JSON: {"stories": [{"article": "...", "subject": "...", "moment": "...", "title": "..."}]}`;
  return parseJson(await ai.generateText(prompt, { maxTokens: 3000, temperature: 0.95 })).stories || [];
}

/**
 * Follow-up episodes for a short that did well: what happened AFTER its moment,
 * taken from the same article, so Part 2 is verified exactly the way Part 1 was.
 */
async function proposeSequel(ai, lane, parent, previously, brief) {
  const prompt = `You plan sequels for the YouTube Shorts channel "${lane.name}".

A short about ${parent.subject} did well with viewers. Its episode: ${parent.moment}
Its narration:
"""
${previously}
"""

Wikipedia article "${brief.title}":
"""
${brief.text.slice(0, 12000)}
"""

Propose up to 4 follow-up episodes for the next part. Rules:
- Each must happen AFTER that episode and continue the same story: the fallout,
  the consequence, the next chapter, how it ended for them.
- It must be stated in the article above, and not already told in the narration.
- Most dramatic first: the one a viewer of the first part would most want to
  know. The first one that passes the fact-check is the one that gets made.
- "moment": one sentence naming the follow-up episode, with its year.
- "title": under 50 characters, states the twist in plain words, and makes sense
  to a viewer who never saw the first part. No emoji, no "Part" (added later).

Return ONLY JSON: {"stories": [{"moment": "...", "title": "..."}]}`;
  return parseJson(await ai.generateText(prompt, { maxTokens: 2000, temperature: 0.7 })).stories || [];
}

/**
 * The part of a long article that is about this episode. Famous players'
 * articles run past 60,000 characters and the episode (Maradona's 1986
 * quarter-final, Zidane's 2006 final) sits deep inside; handing the writer the
 * first 12,000 meant writing from memory, and the fact-check then cut 12 of 14
 * sentences. The lead paragraph plus the paragraphs that mention the episode's
 * own words, in article order, is what the writer and checker both see.
 *
 * maxChars stays under what supported() and narrate() actually read (9,000).
 * At 10,000, a late-article episode — the very kind this exists for — was
 * kept and then sliced off: Mbappé's "Chinese dictator" paragraph (2026-10-30)
 * sat at characters 8,000-9,400, so the checker saw the quote but not the
 * apology, answered NO, and the story was dropped.
 */
const STOP = new Set('with that this from their after when which into over about were have been they them then than also what while where there would could his her the and for its was who how why one two'.split(' '));
function focusBrief(brief, story, maxChars = 8500) {
  const paras = brief.text.split(/\n{2,}|\n(?=[A-Z])/).map((p) => p.trim()).filter((p) => p.length > 40);
  const keys = [...new Set(fold(`${story.moment} ${story.title || ''}`).match(/[a-z0-9]{4,}/g) || [])].filter((k) => !STOP.has(k));
  const scored = paras.map((p, i) => {
    const f = fold(p);
    return { i, p, score: keys.reduce((a, k) => a + (f.includes(k) ? (/^\d{4}$/.test(k) ? 3 : 1) : 0), 0) };
  });
  const keep = new Set([0]);
  let size = paras[0]?.length || 0;
  for (const s of [...scored].sort((a, b) => b.score - a.score)) {
    if (s.score === 0 || size + s.p.length > maxChars) continue;
    keep.add(s.i);
    size += s.p.length;
  }
  const text = scored.filter((s) => keep.has(s.i)).map((s) => s.p).join('\n\n');
  return { ...brief, text };
}

async function supported(ai, story, brief) {
  const prompt = `Wikipedia article "${brief.title}":
"""
${brief.text.slice(0, 9000)}
"""

Does this text describe this specific episode in enough detail to narrate it:
"${story.moment}"
Answer YES or NO.`;
  try {
    return /^\W*yes\b/i.test(String(await ai.generateText(prompt, { maxTokens: 400, temperature: 0 })).trim());
  } catch {
    return false;
  }
}

function unsourcedNumbers(text, brief) {
  const f = (t) => t.normalize('NFKD').replace(/,/g, '').toLowerCase();
  const src = f(brief);
  return [...new Set(f(text).match(/\d[\d.:]*/g) || [])]
    .map((x) => x.replace(/[.:]+$/, ''))
    .filter((x) => x.length > 1 && !src.includes(x));
}

/**
 * Sentence-level fact check against the brief. The number check alone let a
 * Zidane draft through that swapped who scored first in the 2006 final and
 * invented a free kick — every figure in it existed somewhere in the article.
 * Returns the sentences the source does not support.
 */
async function unsupportedSentences(ai, text, brief) {
  const sentences = text.match(/[^.!?]+[.!?]+["'”’]?/g) || [text];
  const numbered = sentences.map((s, i) => `${i + 1}. ${s.trim()}`).join('\n');
  const prompt = `You are a strict fact-checker. SOURCE:
"""
${brief.text.slice(0, 11000)}
"""

NARRATION, numbered by sentence:
${numbered}

For each sentence, decide whether every factual claim in it (who did what,
when, in what order, scores, results, quotes) is stated or directly implied
by the SOURCE. Pure scene-setting with no factual claim ("Tension mounted.")
counts as supported. A claim the source does not mention counts as unsupported.

Return ONLY JSON: {"unsupported": [sentence numbers]}`;
  try {
    const out = parseJson(await ai.generateText(prompt, { maxTokens: 1500, temperature: 0 }));
    return new Set((out.unsupported || []).map(Number).filter((n) => n >= 1 && n <= sentences.length).map((n) => n - 1));
  } catch {
    return null;   // the checker failed: treat the draft as unverified
  }
}

/**
 * Gemini writes the script when it can: it tells a story in order, where
 * gpt-oss at low reasoning drifted into a backwards career recap. Its free tier
 * is 20 requests a day, which two shorts with retries fit inside; when it is
 * out, AITextService falls through to the backups on its own.
 */
function writerAI() {
  const prev = process.env.AI_TEXT_PROVIDER;
  process.env.AI_TEXT_PROVIDER = process.env.STORY_WRITER_PROVIDER || 'gemini';
  const writer = new AITextService({});
  if (prev === undefined) delete process.env.AI_TEXT_PROVIDER; else process.env.AI_TEXT_PROVIDER = prev;
  return writer;
}

async function narrate(ai, story, brief, writer = writerAI(), WORDS = DEFAULT_WORDS) {
  // A sequel is told as the next chapter: what Part 1 said is shown so it is
  // not retold, and one reconnecting line lets a viewer who missed it follow.
  const sequel = story.previously ? `
This is PART ${story.part} of a series. The previous part already told the story
below, so do NOT retell it. Open with ONE sentence that reconnects the viewer to
it, then tell what happened NEXT:
"""
${story.previously}
"""
` : '';
  const base = `Write the narration for a ${WORDS.target}-word YouTube Short about ${story.subject}.
The episode: ${story.moment}
${sequel}
SOURCE — the only place you may take names, dates, numbers, clubs, scores and
quotes from. If a detail is not here, it does not exist:
"""
${brief.text.slice(0, 9000)}
"""

Structure:
1. First sentence is the hook: name ${story.subject} and promise the drama in
   under 20 words, so a viewer swiping past stops.
2. Set up who or what this was and what was at stake, quickly.
3. Tell the episode in the order the SOURCE gives it, building tension sentence
   by sentence. Who scored, when and how must match the source exactly — if the
   source does not say how a goal was scored, do not describe it.
4. The payoff: what actually happened, and what it cost or meant.
5. End on one short, punchy line that lands the story.

Style: spoken, energetic storytelling, short sentences, present the facts
vividly. Past tense. No "you", no "imagine", no "subscribe", no headings, no
emojis, no stage directions. Never name the structure out loud: no "hook",
"payoff", "stakes" or "twist" (the Kane short said "the incredible payoff
arrived"). ${WORDS.min}-${WORDS.max} words. Return only the narration.`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = await writer.generateText(attempt === 1 ? base
      : `${base}\n\nYour previous draft broke a rule (${attempt === 2 ? 'length or invented figures' : 'invented figures'}). Use ONLY numbers that appear in the source.`,
    { maxTokens: 1400, temperature: 0.6 });
    // Non-breaking and figure hyphens (U+2010-2012) come back from the model in
    // "Paris Saint‑Germain" and do not survive every font or the TTS.
    const text = String(raw).replace(/^#+.*$/gm, '').replace(/\*\*/g, '').replace(/[‐-‒]/g, '-').replace(/\s+/g, ' ').trim();
    // The model keeps reaching for a match minute or a cap count the article
    // never states. Rather than lose the story, cut exactly the sentences that
    // carry an unsourced figure; the rest is verified prose.
    const bad = unsourcedNumbers(text, brief.text);
    const kept = bad.length
      ? (text.match(/[^.!?]+[.!?]+["'”’]?/g) || [text]).filter((s) => unsourcedNumbers(s, brief.text).length === 0).join(' ').replace(/\s+/g, ' ').trim()
      : text;
    if (bad.length) logger.info(`dropped sentences with unsourced figures (${bad.join(', ')})`);
    if (words(kept) < WORDS.min) {
      logger.warn(`draft ${attempt}: only ${words(kept)} words after the figure check`);
      continue;
    }

    const flagged = await unsupportedSentences(ai, kept, brief);
    if (!flagged) {
      logger.warn(`draft ${attempt}: fact-check unavailable; not shipping unverified narration`);
      continue;
    }
    const sentences = kept.match(/[^.!?]+[.!?]+["'”’]?/g) || [kept];
    const checked = sentences.filter((_, i) => !flagged.has(i)).join(' ').replace(/\s+/g, ' ').trim();
    if (flagged.size) logger.info(`fact-check cut ${flagged.size} sentence(s): ${[...flagged].map((i) => `"${sentences[i].trim().slice(0, 60)}"`).join(' | ')}`);
    // A bare cut can strand the next sentence: an Alexander draft lost "Darius
    // offered half his empire" and kept "Alexander refused." So the writer gets
    // one chance to retell it without the flagged claims; the retelling only
    // ships if it comes back from the checker clean.
    if (flagged.size) {
      const fixed = String(await writer.generateText(`${base}\n\nHere is a draft:\n"""\n${kept}\n"""\n`
        + `A fact-checker could not find these claims in the SOURCE; leave them out:\n`
        + `${[...flagged].map((i) => `- ${sentences[i].trim()}`).join('\n')}\n`
        + 'Rewrite the whole narration so it still flows without them.', { maxTokens: 1400, temperature: 0.4 }).catch(() => ''))
        .replace(/^#+.*$/gm, '').replace(/\*\*/g, '').replace(/[‐-‒]/g, '-').replace(/\s+/g, ' ').trim();
      const n = words(fixed);
      if (fixed && !unsourcedNumbers(fixed, brief.text).length && n >= WORDS.min && n <= WORDS.max) {
        const again = await unsupportedSentences(ai, fixed, brief);
        if (again && again.size === 0) { logger.info('rewrite passed the fact-check clean'); return fixed; }
        logger.info(`rewrite still had ${again ? again.size : '?'} unsupported sentence(s); using the cut draft`);
      }
    }
    // Cutting more than a quarter of the story leaves holes in the telling.
    // Losing the first sentence loses the hook — a Messi story opened on "The
    // Argentine star..." without ever naming him. The title is already checked
    // against the article and is written to stop a thumb, so it opens instead.
    const opener = String(story.title || '').replace(/[^\p{L}\p{N}\s'’,-]/gu, '').replace(/\s+/g, ' ').trim();
    const final = flagged.has(0) && opener ? `${opener}. ${checked}` : checked;
    const n = words(final);
    if (flagged.size <= Math.ceil(sentences.length / 4) && n >= WORDS.min && n <= WORDS.max) return final;
    logger.warn(`draft ${attempt}: ${n} usable words, unsourced figures: ${bad.join(', ') || 'none'}`);
  }
  return null;
}

/**
 * Narrate `text` in the lane's voice and cut it over `photos` (downloaded
 * Commons files) into <dataRoot>/shorts/video/<id>_short.mp4. Shared by the
 * story shorts and the Sunday roundup, so a change of look happens in one place.
 * Returns { video, seconds }, or { skip } when the narration runs out of bounds.
 */
async function renderStills(lane, id, text, photos, { style = 'v1', title = '', tag = null } = {}) {
  const base = (...p) => path.join(ROOT, lane.dataRoot, ...p);
  const factory = new ShortsFactory({});
  const dirs = Object.fromEntries(['audio', 'captions', 'copy', 'video', 'work'].map((k) => [k, base('shorts', k)]));
  for (const d of Object.values(dirs)) await fsp.mkdir(d, { recursive: true });

  const audio = path.join(dirs.audio, `${id}_short.mp3`);
  const narration = await factory.narrateWithTiming(text, lane.voice, audio);
  const seconds = await factory.probeDuration(audio);
  if (seconds > 178) return { skip: `${seconds.toFixed(0)}s is over the 3-minute Shorts limit` };
  if (seconds < 20.5) return { skip: `${seconds.toFixed(0)}s is under the 20s quality gate` };
  const video = path.join(dirs.video, `${id}_short.mp4`);

  // The second look (utils/short-style-v2.js). Anything going wrong in it —
  // Python missing on a runner, a model download that failed — falls back to
  // the v1 render below on the same narration, so a post is never lost to it.
  if (style === 'v2') {
    const workDir = path.join(dirs.work, id);
    try {
      await renderStoryV2({
        words: narration.words, audioPath: audio, photos: photos.map((p) => p.path), title, tag,
        look: lane.look || 'football', accent: lane.captionHighlight, outputPath: video, workDir, logger
      });
      return { video, seconds, style: 'v2' };
    } catch (error) {
      logger.warn(`${id}: v2 render failed (${String(error.message).slice(0, 160)}); rendering the v1 look`);
    } finally {
      await fsp.rm(workDir, { recursive: true, force: true });
    }
  }

  const captions = path.join(dirs.captions, `${id}_short.ass`);
  // Captions never wrap (WrapStyle 2), so three long words ran off the frame
  // ("CONSULTED HIS ASSISTANT"); two words at 84px stays inside 1080px.
  await fsp.writeFile(captions, factory.buildCaptions(narration.words,
    { wordsPerChunk: 2, fontSize: 84, ...(lane.captionHighlight ? { highlightColor: lane.captionHighlight } : {}) }));

  const count = Math.max(photos.length, Math.ceil(seconds / SECONDS_PER_IMAGE));
  const per = seconds / count;
  const clips = [];
  for (let i = 0; i < count; i++) {
    const clip = path.join(dirs.work, `${id}_${i}.mp4`);
    await factory.stillToClip(photos[i % photos.length].path, per, clip);
    clips.push(clip);
  }
  await factory.renderShort({ storyClips: clips, motionClip: null, layout: 'full', audioPath: audio, captionPath: captions, outputPath: video });
  await Promise.all(clips.map((c) => fsp.unlink(c).catch(() => {})));
  return { video, seconds, style: 'v1' };
}

/**
 * Which look a lane's next story gets. `lane.v2`: 'on', 'off' (default), or
 * 'ab' — the two looks alternate by count, so after two weeks they have the
 * same number of posts and their views and average-watched can be compared
 * straight from stories.json's `style` field.
 */
function chooseStyle(lane, done) {
  if (lane.v2 === 'on') return 'v2';
  if (lane.v2 !== 'ab') return 'v1';
  const n = (s) => done.filter((d) => d.style === s).length;
  return n('v2') <= n('v1') ? 'v2' : 'v1';
}

// Subjects any lane picked in this process. Every lane sees the same trending
// list, and on 2026-10-22 AFTER CACHE and Viral Vault Clip both chose
// Elizabeth Holmes; one channel per subject per day.
const takenThisRun = new Set();

/**
 * `sequelOf` is a stories.json entry (with its videoId) to continue: the next
 * part of that story replaces a fresh pick. See scripts/autopilot/sequels.js.
 */
async function makeStoryShort(laneName, { dryRun = false, sequelOf = null, story: pinned = null } = {}) {
  const lane = LANES.find((l) => l.name.toLowerCase() === String(laneName).toLowerCase());
  if (!lane) throw new Error(`no lane "${laneName}"`);
  const base = (...p) => path.join(ROOT, lane.dataRoot, ...p);

  const ai = new AITextService({});
  const writer = writerAI();
  const research = new ResearchService();
  const archival = new ArchivalImageService();
  const storiesPath = base('stories.json');
  const done = readJson(storiesPath, []);
  const ledger = readJson(base('shorts', 'uploads.json'), {});
  const avoid = [...done.map((d) => `${d.subject}: ${d.moment}`),
    ...Object.entries(ledger).filter(([id]) => !id.startsWith('reddit-')).map(([, v]) => String(v.title || '').replace(/\s*#Shorts$/i, ''))].slice(-120);
  // Same subject at most once a fortnight, so the feed is not one player.
  const recent = new Set(done.filter((d) => Date.now() - Date.parse(d.at) < 14 * 86400000).map((d) => fold(d.subject)));
  const hot = sequelOf || pinned ? [] : await trending();
  if (hot.length) logger.info(`trending: ${hot.slice(0, 12).join(' | ')} …`);
  const news = sequelOf || pinned || !lane.news ? [] : (await footballNews()).slice(0, 30);
  if (news.length) logger.info(`news: ${news.length} headlines, e.g. ${news.slice(0, 3).map((n) => n.title).join(' | ')}`);

  // Posted is posted. A story asked for by name skips the fortnight rule, so
  // asking twice for the same news in other words would post it twice; the
  // same article within a week is refused instead.
  if (pinned) {
    const again = done.find((d) => fold(d.article) === fold(pinned.article) && Date.now() - Date.parse(d.at) < 7 * 86400000);
    if (again) throw new Error(`already posted from "${pinned.article}" on ${again.at.slice(0, 10)}: "${again.title}"`);
  }

  // A sequel continues one story, so its article is fixed and read once, and
  // Part 1's own narration tells the planner and the writer what not to repeat.
  let sequel = null;
  if (sequelOf) {
    const full = await research.buildBriefFromArticle(sequelOf.article, { maxChars: 150000 }).catch(() => null);
    if (!full || full.text.length < 3000) throw new Error(`no usable article text for ${sequelOf.article}`);
    const copy = await fsp.readFile(base('shorts', 'copy', `${sequelOf.id}_short.txt`), 'utf8').catch(() => '');
    const previously = copy.split(/\n\nSource:/)[0].replace(/^◀.*\n+/, '').trim() || sequelOf.moment;
    sequel = { full, previously, part: (sequelOf.part || 1) + 1, root: sequelOf.root || sequelOf.id };
    logger.info(`sequel: Part ${sequel.part} of ${sequelOf.id}`);
  }

  for (let round = 1; round <= (sequel || pinned ? 1 : 2); round++) {
    let stories;
    try {
      // Round 2 drops the trending list, in case it pulled round 1 off-scope.
      // A pinned story (asked for by name) skips the proposal step entirely,
      // and still goes through the same article check, fact-check and render.
      stories = pinned ? [pinned] : sequel
        ? (await proposeSequel(ai, lane, sequelOf, sequel.previously, focusBrief(sequel.full, sequelOf, 11500)))
          .map((s) => ({ ...s, article: sequelOf.article, subject: sequelOf.subject }))
        : await propose(ai, lane, avoid, round === 1 ? hot : [], round === 1 ? news : []);
    } catch (error) {
      logger.warn(`proposal round ${round} failed: ${error.message}`);
      continue;
    }
    for (const story of stories) {
      const subject = String(story.subject || '').replace(/\([^)]*\)/g, '').trim();
      if (!story.article || !subject) continue;
      // The fortnight-per-subject rule is for fresh picks; a sequel is the same subject by design.
      if (!sequel && !pinned && (recent.has(fold(subject)) || takenThisRun.has(fold(subject)))) continue;
      if (done.some((d) => fold(d.moment) === fold(story.moment))) continue;

      let brief;
      if (sequel) {
        // Keyed on both episodes, so the line reconnecting to Part 1 is in the
        // source the fact-checker reads instead of being cut as unsupported.
        brief = focusBrief(sequel.full, { moment: `${sequelOf.moment} ${story.moment}`, title: story.title });
      } else {
        const full = await research.buildBriefFromArticle(story.article, { maxChars: 150000 }).catch(() => null);
        if (!full || full.text.length < 3000) { logger.info(`skip ${story.article}: thin or missing article`); continue; }
        brief = focusBrief(full, story);
      }
      if (!(await supported(ai, story, brief))) { logger.info(`skip "${story.moment}": not in the article`); continue; }

      const found = await archival.gatherForTopic([subject], { must: [subject], bonus: [] }, { perQuery: 30, total: 10 }).catch(() => []);
      // Events rarely carry their name in Commons filenames; the article's own
      // photographs fill the gap (see fetchArticleImages).
      if (found.length < 6) {
        const seen = new Set(found.map((f) => f.title));
        for (const img of await archival.fetchArticleImages(brief.title || story.article).catch(() => [])) {
          if (!seen.has(img.title) && found.length < 10) { found.push(img); seen.add(img.title); }
        }
      }
      if (found.length < 3) { logger.info(`skip ${subject}: only ${found.length} usable photo(s)`); continue; }

      const text = await narrate(ai, { ...story, subject, ...(sequel ? { previously: sequel.previously, part: sequel.part } : {}) },
        brief, writer, lane.story?.words || DEFAULT_WORDS);
      if (!text) { logger.info(`skip ${subject}: no clean narration`); continue; }

      // The model still stacks emojis ("😳💀") despite the rule; keep the first.
      let seen = false;
      let title = String(story.title)
        .replace(/\p{Extended_Pictographic}️?/gu, (e) => (seen ? '' : ((seen = true), e)))
        .replace(/[‐-‒]/g, '-')   // non-breaking hyphens, as in the narration
        .replace(/\s+/g, ' ').trim().slice(0, sequel ? 70 : 80);
      if (sequel) title = `${title.replace(/[.!?]+$/, '')} (Part ${sequel.part})`;
      let id = sequel
        ? `story-${slug(subject, 20)}-p${sequel.part}-${slug(story.moment, 12)}`
        : `story-${slug(subject, 20)}-${slug(story.moment, 16)}`;
      while (ledger[id]) id += 'x';
      takenThisRun.add(fold(subject));
      logger.success(`${id}: "${title}" — ${words(text)} words`);
      if (dryRun) return { id, title, text, subject, article: brief.title, photos: found.length, ...(sequel ? { part: sequel.part } : {}) };

      // ---- render
      const imgDir = base('reference', id);
      const saved = await archival.downloadArchivalImages(found, imgDir);
      if (saved.length < 3) { logger.info(`skip ${subject}: photo downloads failed`); continue; }

      const rendered = await renderStills(lane, id, text, saved,
        { style: chooseStyle(lane, done), title, tag: sequel ? `Part ${sequel.part}` : null });
      if (rendered.skip) { logger.warn(`${id}: ${rendered.skip}`); continue; }
      const { video, seconds } = rendered;
      const dirs = { copy: base('shorts', 'copy') };
      // The photos are only needed for this render, and their credits are in the copy.
      await fsp.rm(imgDir, { recursive: true, force: true });

      // The description is the copy file; CC BY photos are only legal credited.
      const credits = saved.map((s) => `• ${s.title.replace(/^File:/, '')} — ${String(s.artist || 'unknown').slice(0, 80)}, ${s.license}`);
      // A sequel's first description line points back, for anyone who lands here first.
      const back = sequel ? `◀ Part ${sequel.part - 1}: https://youtube.com/shorts/${sequelOf.videoId}\n\n` : '';
      await fsp.writeFile(path.join(dirs.copy, `${id}_short.txt`),
        `${back}${text}\n\nSource: ${brief.url}\nPhotos (Wikimedia Commons):\n${credits.join('\n')}`);

      const queuePath = base('queue.json');
      const queue = readJson(queuePath, { topics: [] });
      queue.topics.push({ id, topic: story.moment, keywords: [subject, ...(lane.story || DEFAULT_STORY).tags], status: 'short', shortTitle: title, article: brief.title, categoryId: lane.categoryId });
      await fsp.writeFile(queuePath, JSON.stringify(queue, null, 2));

      const series = sequel ? { sequelOf: sequelOf.id, part: sequel.part, root: sequel.root } : {};
      done.push({ id, subject, article: brief.title, moment: story.moment, title, at: new Date().toISOString(), style: rendered.style, ...series });
      await fsp.writeFile(storiesPath, JSON.stringify(done, null, 2));
      return { id, title, video, seconds, ...series };
    }
  }
  throw new Error('no story survived verification this run');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const valueFlags = ['--sequel', '--article', '--subject', '--moment', '--title'];
  const laneName = args.find((a, i) => !a.startsWith('--') && !valueFlags.includes(args[i - 1]));
  let sequelOf = null;
  if (args.includes('--sequel')) {
    const sid = args[args.indexOf('--sequel') + 1];
    const lane = LANES.find((l) => l.name.toLowerCase() === String(laneName).toLowerCase());
    const story = lane && readJson(path.join(ROOT, lane.dataRoot, 'stories.json'), []).find((s) => s.id === sid);
    const entry = lane && readJson(path.join(ROOT, lane.dataRoot, 'shorts', 'uploads.json'), {})[sid];
    if (!story || !entry?.videoId) { logger.error(`no uploaded story "${sid}" in ${laneName}`); process.exit(1); }
    sequelOf = { ...story, videoId: entry.videoId, url: entry.url };
  }
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
  const pinned = opt('--article')
    ? { article: opt('--article'), subject: opt('--subject') || opt('--article').replace(/\([^)]*\)/g, '').trim(), moment: opt('--moment'), title: opt('--title') }
    : null;
  if (pinned && (!pinned.moment || !pinned.title)) { logger.error('--article needs --moment and --title'); process.exit(1); }
  makeStoryShort(laneName, { dryRun: args.includes('--dry-run'), sequelOf, story: pinned })
    .then((r) => console.log(JSON.stringify({ ...r, text: r.text ? `${r.text.slice(0, 400)}…` : undefined }, null, 2)))
    .catch((e) => { logger.error(`story-short failed: ${e.message}`); process.exit(1); });
}

module.exports = { makeStoryShort, renderStills, chooseStyle, unsupportedSentences, parseJson, trending };
