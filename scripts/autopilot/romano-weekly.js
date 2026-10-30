#!/usr/bin/env node
/**
 * Sunday: the week's football news as Fabrizio Romano reported it, in one short.
 *
 *   node scripts/autopilot/romano-weekly.js "Football Files"            # make it
 *   node scripts/autopilot/romano-weekly.js "Football Files" --dry-run  # pick + write, render nothing
 *
 * Why Romano: he is the transfer reporter the audience trusts ("here we go"),
 * and every outlet writes up what he says within hours. Those write-ups are
 * the source here — Google News headlines naming him, with their outlets
 * (utils/news-feed.js). His own posts are on X, which has no free API.
 *
 * The rules that keep this honest, since news is not on Wikipedia yet:
 *   - every story is ATTRIBUTED ("Romano says / reports"), never stated as fact;
 *   - every sentence is fact-checked against the week's headlines, and anything
 *     the headlines do not carry is cut (fees, dates and quotes included);
 *   - the description lists each outlet and headline used, and says the video
 *     is a roundup of his reporting, not affiliated with him.
 */

require('dotenv').config();

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { AITextService } = require('../../utils/ai-text-service');
const { ArchivalImageService } = require('../../utils/archival-images');
const { newsSearch } = require('../../utils/news-feed');
const { Logger } = require('../../utils/logger');
const { renderStills, unsupportedSentences, parseJson } = require('./story-short');
const { LANES } = require('./lanes');

const ROOT = path.join(__dirname, '..', '..');
const logger = new Logger('RomanoWeekly');
// Five stories at ~30 words each, plus an opener and a closer: ~60-85s.
const WORDS = { min: 110, target: 150, max: 200 };
const words = (t) => String(t).trim().split(/\s+/).filter(Boolean).length;
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return fb; } };

async function pickStories(ai, corpus) {
  const prompt = `Below are this week's football headlines that mention Fabrizio Romano,
numbered, each with its outlet and date.

"""
${corpus}
"""

Pick the 5 biggest DISTINCT football stories Romano reported this week. Rules:
- A story carried by several outlets beats one carried by one.
- Skip betting tips, podcasts, adverts, opinion pieces, and anything that is
  only "linked" without a claim attributed to Romano.
- "subject": the player, manager or club at the centre, as their English
  Wikipedia article is titled (used to find a photo).
- "claim": ONE sentence saying what Romano reported, using only what the
  headlines say. No fee, date or quote that is not in a headline.
- "headlines": the numbers of the headlines that carry it.

Return ONLY JSON: {"stories": [{"subject": "...", "claim": "...", "headlines": [1, 2]}]}`;
  return parseJson(await ai.generateText(prompt, { maxTokens: 2000, temperature: 0.3 })).stories || [];
}

async function writeScript(ai, picks, corpus, redo = '') {
  const prompt = `Write the narration for a ${WORDS.target}-word YouTube Short: Fabrizio Romano's
five biggest football stories of the week, counted down from five to one.

The five stories, biggest last:
${picks.map((p, i) => `${5 - i}. ${p.subject}: ${p.claim}`).join('\n')}

SOURCE — the only place you may take names, clubs, fees, dates and quotes from:
"""
${corpus}
"""

Structure:
1. Open in under 15 words: Fabrizio Romano's biggest stories this week, counted down.
2. "Number five" down to "Number one", one or two short sentences each, every one
   ATTRIBUTED to Romano ("Romano says", "according to Fabrizio Romano").
3. Close with one short line that lands the week.

Style: spoken, punchy, short sentences, present tense. No "you", no "subscribe",
no emojis, no headings. Never state a rumour as fact. ${WORDS.min}-${WORDS.max} words.
Return only the narration.${redo}`;
  return String(await ai.generateText(prompt, { maxTokens: 1400, temperature: 0.5 }))
    .replace(/^#+.*$/gm, '').replace(/\*\*/g, '').replace(/[‐-‒]/g, '-').replace(/\s+/g, ' ').trim();
}

/** The narration, with every sentence the headlines do not support removed. */
async function verifiedScript(ai, picks, corpus) {
  let redo = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const text = await writeScript(ai, picks, corpus, redo);
    const flagged = await unsupportedSentences(ai, text, { text: corpus });
    if (!flagged) { logger.warn(`draft ${attempt}: fact-check unavailable; not shipping unverified news`); continue; }
    const sentences = text.match(/[^.!?]+[.!?]+["'”’]?/g) || [text];
    const kept = sentences.filter((_, i) => !flagged.has(i)).join(' ').replace(/\s+/g, ' ').trim();
    if (flagged.size) logger.info(`fact-check cut ${flagged.size} sentence(s): ${[...flagged].map((i) => `"${sentences[i].trim().slice(0, 60)}"`).join(' | ')}`);
    // News is the one place a cut cannot be patched over with colour: if the
    // checker removed more than a fifth, the draft was guessing, so write again.
    if (flagged.size <= Math.ceil(sentences.length / 5) && words(kept) >= WORDS.min) return kept;
    redo = `\n\nYour previous draft stated things the headlines do not say:\n${[...flagged].map((i) => `- ${sentences[i].trim()}`).join('\n')}\nLeave anything like that out.`;
    logger.warn(`draft ${attempt}: ${flagged.size} unsupported, ${words(kept)} usable words`);
  }
  return null;
}

async function makeRomanoRoundup(laneName, { dryRun = false } = {}) {
  const lane = LANES.find((l) => l.name.toLowerCase() === String(laneName).toLowerCase());
  if (!lane) throw new Error(`no lane "${laneName}"`);
  const base = (...p) => path.join(ROOT, lane.dataRoot, ...p);
  const ai = new AITextService({});

  const items = await newsSearch('"Fabrizio Romano"', { days: 7, limit: 60 });
  if (items.length < 8) throw new Error(`only ${items.length} Romano headlines this week`);
  const corpus = items.map((it, i) => `${i + 1}. ${it.title} (${it.outlet}, ${it.date.slice(0, 10)})`).join('\n');
  logger.info(`${items.length} headlines naming Romano this week`);

  const picks = (await pickStories(ai, corpus)).filter((p) => p.subject && p.claim).slice(0, 5);
  if (picks.length < 3) throw new Error(`only ${picks.length} usable stories in the headlines`);
  logger.info(`stories: ${picks.map((p) => p.subject).join(' | ')}`);

  const text = await verifiedScript(ai, picks, corpus);
  if (!text) throw new Error('no narration survived the fact-check');

  // Two photos per subject, so the picture follows the countdown.
  const archival = new ArchivalImageService();
  const found = [];
  for (const p of picks) {
    const subject = String(p.subject).replace(/\([^)]*\)/g, '').trim();
    const last = subject.split(/\s+/).pop();
    found.push(...await archival.gatherForTopic([subject], { must: [last], bonus: [subject] }, { perQuery: 15, total: 2 }).catch(() => []));
  }
  if (found.length < 4) throw new Error(`only ${found.length} usable photos`);

  const day = new Date().toISOString().slice(0, 10);
  const id = `story-romano-week-${day}`;
  const title = "Fabrizio Romano's 5 Biggest Stories This Week";
  logger.success(`${id}: "${title}" — ${words(text)} words, ${found.length} photos`);
  if (dryRun) return { id, title, text, picks, photos: found.length };

  const imgDir = base('reference', id);
  const saved = await archival.downloadArchivalImages(found, imgDir);
  if (saved.length < 4) throw new Error('photo downloads failed');
  const rendered = await renderStills(lane, id, text, saved);
  await fsp.rm(imgDir, { recursive: true, force: true });
  if (rendered.skip) throw new Error(rendered.skip);

  const used = [...new Set(picks.flatMap((p) => p.headlines || []).map(Number))]
    .filter((n) => items[n - 1]).map((n) => `• ${items[n - 1].outlet}: ${items[n - 1].title}`);
  const credits = saved.map((s) => `• ${s.title.replace(/^File:/, '')} — ${String(s.artist || 'unknown').slice(0, 80)}, ${s.license}`);
  await fsp.writeFile(base('shorts', 'copy', `${id}_short.txt`),
    `${text}\n\nAs reported by Fabrizio Romano, via:\n${used.join('\n')}\n\n`
    + 'A weekly roundup of Fabrizio Romano\'s reporting. Not affiliated with Fabrizio Romano.\n'
    + `Photos (Wikimedia Commons):\n${credits.join('\n')}`);

  const queuePath = base('queue.json');
  const queue = readJson(queuePath, { topics: [] });
  queue.topics.push({
    id, topic: `Fabrizio Romano's football news, week to ${day}`, status: 'short', shortTitle: title, categoryId: lane.categoryId,
    keywords: ['Fabrizio Romano', 'transfer news', 'football news', ...picks.map((p) => p.subject)].slice(0, 15)
  });
  await fsp.writeFile(queuePath, JSON.stringify(queue, null, 2));
  return { id, title, video: rendered.video, seconds: rendered.seconds };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  makeRomanoRoundup(args.find((a) => !a.startsWith('--')), { dryRun: args.includes('--dry-run') })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { logger.error(`romano-weekly failed: ${e.message}`); process.exit(1); });
}

module.exports = { makeRomanoRoundup };
