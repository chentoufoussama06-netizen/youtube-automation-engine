#!/usr/bin/env node
/**
 * A ~2:40 story short about a famous player's most dramatic moment.
 *
 *   node scripts/autopilot/story-short.js "Football Files"            # make one
 *   node scripts/autopilot/story-short.js "Football Files" --dry-run  # pick + write, render nothing
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
const { AITextService } = require('../../utils/ai-text-service');
const { ResearchService } = require('../../utils/research-service');
const { ArchivalImageService } = require('../../utils/archival-images');
const { ShortsFactory } = require('../../utils/shorts-factory');
const { Logger } = require('../../utils/logger');
const { LANES } = require('./lanes');

const ROOT = path.join(__dirname, '..', '..');
const logger = new Logger('StoryShort');

const WORDS = { min: 250, target: 360, max: 420 };   // ~1:50-2:55 at Edge TTS pace
const SECONDS_PER_IMAGE = 6;

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const slug = (s, max = 30) => fold(s).replace(/\([^)]*\)/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, max).replace(/-$/, '');
const words = (t) => String(t).trim().split(/\s+/).filter(Boolean).length;
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch { return fb; } };

function parseJson(raw) {
  const text = String(raw || '').replace(/```(?:json)?/gi, '');
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s === -1 || e <= s) throw new Error('no JSON in reply');
  return JSON.parse(text.slice(s, e + 1));
}

async function propose(ai, lane, avoid) {
  const prompt = `You pick stories for the YouTube Shorts channel "${lane.name}".

The format that is winning right now (titles and views from a 4-month-old channel):
- When Balotelli Completely Lost His Mind 😭🔥  (4.4M)
- The Ronaldo Comeback Nobody Was Ready For 😭🔥  (2.0M)
- How Did Ronaldo Even Do This 😭🔥  (1.5M)
- Football Gave Torres the SAME Chance Twice  (1.2M)
- The Man Who DESTROYED the Galácticos 💀  (1.1M)
- The Champions League Run That Made ZERO Sense 😭🔥  (1.0M)
- When Karma DESTROYED an Entire National Team 😭🔥  (0.7M)

Propose 10 stories like these. Rules:
- About a FAMOUS footballer, manager, club or national team that casual fans
  worldwide know. Not obscure lower-league subjects.
- One specific, dramatic episode with an arc: meltdown, betrayal, impossible
  comeback, karma, redemption, rivalry turning into war, a season that made no
  sense, a career that collapsed, a disappearance.
- It must be documented in that subject's English Wikipedia article.
- "article": the EXACT English Wikipedia article title of the person, club or event.
- "subject": the name a photo caption would use (e.g. "Mario Balotelli"), no parentheses.
- "moment": one sentence naming the episode, with its year.
- "title": under 55 characters, curiosity gap, ends with 1-2 of these emojis 😭🔥💀🤯🥶😳.
  Capitalise like the examples. Never promise something the article cannot back.
- Do NOT reuse anything already posted:
${avoid.map((t) => `  - ${t}`).join('\n') || '  (nothing yet)'}

Return ONLY JSON: {"stories": [{"article": "...", "subject": "...", "moment": "...", "title": "..."}]}`;
  return parseJson(await ai.generateText(prompt, { maxTokens: 3000, temperature: 0.95 })).stories || [];
}

/**
 * The part of a long article that is about this episode. Famous players'
 * articles run past 60,000 characters and the episode (Maradona's 1986
 * quarter-final, Zidane's 2006 final) sits deep inside; handing the writer the
 * first 12,000 meant writing from memory, and the fact-check then cut 12 of 14
 * sentences. The lead paragraph plus the paragraphs that mention the episode's
 * own words, in article order, is what the writer and checker both see.
 */
const STOP = new Set('with that this from their after when which into over about were have been they them then than also what while where there would could his her the and for its was who how why one two'.split(' '));
function focusBrief(brief, story, maxChars = 10000) {
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

async function narrate(ai, story, brief, writer = writerAI()) {
  const base = `Write the narration for a ${WORDS.target}-word YouTube Short about ${story.subject}.
The episode: ${story.moment}

SOURCE — the only place you may take names, dates, numbers, clubs, scores and
quotes from. If a detail is not here, it does not exist:
"""
${brief.text.slice(0, 9000)}
"""

Structure:
1. First sentence is the hook: name ${story.subject} and promise the drama in
   under 20 words, so a viewer swiping past stops.
2. Set up who he was and what was at stake, quickly.
3. Tell the episode in the order the SOURCE gives it, building tension sentence
   by sentence. Who scored, when and how must match the source exactly — if the
   source does not say how a goal was scored, do not describe it.
4. The payoff: what actually happened, and what it cost or meant.
5. End on one short, punchy line that lands the story.

Style: spoken, energetic storytelling, short sentences, present the facts
vividly. Past tense. No "you", no "imagine", no "subscribe", no headings, no
emojis, no stage directions. ${WORDS.min}-${WORDS.max} words. Return only the narration.`;

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

async function makeStoryShort(laneName, { dryRun = false } = {}) {
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

  for (let round = 1; round <= 2; round++) {
    let stories;
    try {
      stories = await propose(ai, lane, avoid);
    } catch (error) {
      logger.warn(`proposal round ${round} failed: ${error.message}`);
      continue;
    }
    for (const story of stories) {
      const subject = String(story.subject || '').replace(/\([^)]*\)/g, '').trim();
      if (!story.article || !subject || recent.has(fold(subject))) continue;
      if (done.some((d) => fold(d.moment) === fold(story.moment))) continue;

      const full = await research.buildBriefFromArticle(story.article, { maxChars: 150000 }).catch(() => null);
      if (!full || full.text.length < 3000) { logger.info(`skip ${story.article}: thin or missing article`); continue; }
      const brief = focusBrief(full, story);
      if (!(await supported(ai, story, brief))) { logger.info(`skip "${story.moment}": not in the article`); continue; }

      const found = await archival.gatherForTopic([subject], { must: [subject], bonus: [] }, { perQuery: 30, total: 10 }).catch(() => []);
      if (found.length < 3) { logger.info(`skip ${subject}: only ${found.length} usable photo(s)`); continue; }

      const text = await narrate(ai, { ...story, subject }, brief, writer);
      if (!text) { logger.info(`skip ${subject}: no clean narration`); continue; }

      const title = String(story.title).replace(/\s+/g, ' ').trim().slice(0, 80);
      let id = `story-${slug(subject, 20)}-${slug(story.moment, 16)}`;
      while (ledger[id]) id += 'x';
      logger.success(`${id}: "${title}" — ${words(text)} words`);
      if (dryRun) return { id, title, text, subject, article: brief.title, photos: found.length };

      // ---- render
      const imgDir = base('reference', id);
      const saved = await archival.downloadArchivalImages(found, imgDir);
      if (saved.length < 3) { logger.info(`skip ${subject}: photo downloads failed`); continue; }

      const factory = new ShortsFactory({});
      const dirs = Object.fromEntries(['audio', 'captions', 'copy', 'video', 'work'].map((k) => [k, base('shorts', k)]));
      for (const d of Object.values(dirs)) await fsp.mkdir(d, { recursive: true });

      const audio = path.join(dirs.audio, `${id}_short.mp3`);
      const narration = await factory.narrateWithTiming(text, lane.voice, audio);
      const seconds = await factory.probeDuration(audio);
      if (seconds > 178) { logger.warn(`${id}: ${seconds.toFixed(0)}s is over the 3-minute Shorts limit`); continue; }

      const captions = path.join(dirs.captions, `${id}_short.ass`);
      // Captions never wrap (WrapStyle 2), so three long words ran off the frame
      // ("CONSULTED HIS ASSISTANT"); two words at 84px stays inside 1080px.
      await fsp.writeFile(captions, factory.buildCaptions(narration.words, { wordsPerChunk: 2, fontSize: 84 }));

      const count = Math.max(saved.length, Math.ceil(seconds / SECONDS_PER_IMAGE));
      const per = seconds / count;
      const clips = [];
      for (let i = 0; i < count; i++) {
        const clip = path.join(dirs.work, `${id}_${i}.mp4`);
        await factory.stillToClip(saved[i % saved.length].path, per, clip);
        clips.push(clip);
      }
      const video = path.join(dirs.video, `${id}_short.mp4`);
      await factory.renderShort({ storyClips: clips, motionClip: null, layout: 'full', audioPath: audio, captionPath: captions, outputPath: video });
      await Promise.all(clips.map((c) => fsp.unlink(c).catch(() => {})));
      // The photos are only needed for this render, and their credits are in the copy.
      await fsp.rm(imgDir, { recursive: true, force: true });

      // The description is the copy file; CC BY photos are only legal credited.
      const credits = saved.map((s) => `• ${s.title.replace(/^File:/, '')} — ${String(s.artist || 'unknown').slice(0, 80)}, ${s.license}`);
      await fsp.writeFile(path.join(dirs.copy, `${id}_short.txt`),
        `${text}\n\nSource: ${brief.url}\nPhotos (Wikimedia Commons):\n${credits.join('\n')}`);

      const queuePath = base('queue.json');
      const queue = readJson(queuePath, { topics: [] });
      queue.topics.push({ id, topic: story.moment, keywords: [subject, 'football', 'football story'], status: 'short', shortTitle: title, article: brief.title });
      await fsp.writeFile(queuePath, JSON.stringify(queue, null, 2));

      done.push({ id, subject, article: brief.title, moment: story.moment, title, at: new Date().toISOString() });
      await fsp.writeFile(storiesPath, JSON.stringify(done, null, 2));
      return { id, title, video, seconds };
    }
  }
  throw new Error('no story survived verification this run');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  makeStoryShort(args.find((a) => !a.startsWith('--')), { dryRun: args.includes('--dry-run') })
    .then((r) => console.log(JSON.stringify({ ...r, text: r.text ? `${r.text.slice(0, 400)}…` : undefined }, null, 2)))
    .catch((e) => { logger.error(`story-short failed: ${e.message}`); process.exit(1); });
}

module.exports = { makeStoryShort, unsupportedSentences };
