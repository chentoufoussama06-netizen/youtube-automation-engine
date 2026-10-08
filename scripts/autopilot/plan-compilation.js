#!/usr/bin/env node
/**
 * Invent the next compilation for a channel, with no human in the loop.
 *
 *   node scripts/autopilot/plan-compilation.js "Football Files"
 *   node scripts/autopilot/plan-compilation.js "AFTER CACHE" --dry-run
 *
 * Writes what build-compilation.js already consumes — queue topics plus a
 * definition in <dataRoot>/compilations/<id>.json — so everything downstream
 * of this file is the existing, already-debugged pipeline.
 *
 * The model only PROPOSES. Every subject it names must resolve to a real
 * Wikipedia article with enough text to source a segment, and that article's
 * brief is cached under the segment id, so the narration is later written from
 * the article this step verified rather than from whatever a fresh search turns
 * up. A subject the channel has already covered is dropped before it costs
 * anything.
 *
 * Segments carry no hand-written outcome. build-compilation.js reads a missing
 * outcome as "do not state how many died or survived", which is the safe
 * reading for a set nobody checked by hand.
 */

require('dotenv').config();

const fsp = require('fs').promises;
const path = require('path');
const { AITextService } = require('../../utils/ai-text-service');
const { ResearchService } = require('../../utils/research-service');
const { Logger } = require('../../utils/logger');
const { LANES } = require('./lanes');

const ROOT = path.join(__dirname, '..', '..');
const BRIEF_CACHE_DIR = path.join(ROOT, 'data', 'research', 'briefs');
const logger = new Logger('PlanCompilation');

const WANT_SEGMENTS = 7;
const MIN_SEGMENTS = 4;
// build-compilation.js refuses briefs under 1,200 characters. Asking for more
// here leaves headroom so a planned segment does not die at build time.
const MIN_BRIEF_CHARS = 2000;

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const slug = (s, max) => fold(s).replace(/\([^)]*\)/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, max).replace(/-$/, '');
const readJson = (p, fallback) => fsp.readFile(p, 'utf8').then(JSON.parse).catch(() => fallback);

/** Everything the channel has already made, so the planner can steer around it. */
async function coverage(lane) {
  const base = path.join(ROOT, lane.dataRoot);
  const queue = await readJson(path.join(base, 'queue.json'), { topics: [] });
  const ledger = await readJson(path.join(base, 'shorts', 'uploads.json'), {});
  const defsDir = path.join(base, 'compilations');
  const defs = await fsp.readdir(defsDir).catch(() => []);
  const compilations = [];
  for (const f of defs.filter((n) => n.endsWith('.json'))) {
    const def = await readJson(path.join(defsDir, f), null);
    if (def) compilations.push(def.title);
  }

  // Reddit-sourced ledger entries are noise to a documentary planner.
  const shortTitles = Object.entries(ledger)
    .filter(([id]) => !id.startsWith('reddit-'))
    .map(([, v]) => String(v.title || '').replace(/\s*#Shorts$/i, ''));

  return {
    queue,
    ids: new Set([...queue.topics.map((t) => t.id), ...Object.keys(ledger)]),
    subjects: new Set(queue.topics.map((t) => fold((t.keywords || [])[0] || t.topic))),
    avoid: [...new Set([...compilations, ...queue.topics.map((t) => t.topic), ...shortTitles])].slice(-150)
  };
}

function parseJson(raw) {
  const text = String(raw || '').replace(/```(?:json)?/gi, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error(`planner returned no JSON object (${text.length} chars: "${text.slice(0, 120).replace(/\s+/g, ' ')}")`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

async function propose(ai, lane, avoid, rejected, keepTitle = null, have = []) {
  // A short set is topped up rather than thrown away: three verified stories
  // under one title are worth more than starting a fourth title from zero.
  if (keepTitle) {
    const prompt = `The YouTube channel "${lane.name}" (${lane.niche}) is making a documentary
compilation titled "${keepTitle}". It already has these verified stories:
${have.map((h) => `- ${h}`).join('\n')}

Propose ${WANT_SEGMENTS} MORE real stories that belong in exactly that title, each with
its own detailed English Wikipedia article.
Do not repeat the ones above or any of these: ${[...avoid.slice(-60), ...rejected].join('; ')}

Return ONLY JSON: {"title": "${keepTitle}", "segments": [
  {"article": "exact English Wikipedia title", "subject": "caption name, no parentheses",
   "topic": "one-line description", "angle": "one sentence", "context": ["year", "company or place"]}
]}`;
    return parseJson(await ai.generateText(prompt, { maxTokens: 6000, temperature: 0.8 }));
  }

  const prompt = `You plan videos for the YouTube channel "${lane.name}".
Niche: ${lane.niche}

The format is a 9-14 minute documentary COMPILATION: one searchable set, told
story by story. Titles that win in this niche look like:
${lane.winningTitles.map((t) => `- ${t}`).join('\n')}

Plan ONE new compilation. Requirements:
- The title names a set people already search for or instantly want to see the
  whole of ("Every ...", "The ... That ...", "How Every ..."). Under 70 characters.
  No clickbait the video cannot deliver, no emojis, no ALL CAPS words.
  The title must be LITERALLY true of every story in the set — each story is
  checked against its Wikipedia article and dropped if it does not fit. Avoid
  exaggerations a source will not back ("overnight", "on day one", "instantly").
- ${WANT_SEGMENTS} stories, each a REAL, well-documented person or event that has
  its own detailed English Wikipedia article.
- "article" must be the EXACT English Wikipedia article title.
- "subject" is the short name a photo caption would use (a person's or club's
  name, or the event's common name) — no parentheses.
- Order the stories weakest to strongest; the most famous one goes last.
- "hook" is one sentence for the opening of the video. It must be true of every
  story in the set and must not state a count of deaths or survivors.
- Do NOT reuse any of these, the channel already covered them:
${avoid.map((t) => `  - ${t}`).join('\n') || '  (nothing yet)'}
${rejected.length ? `- These failed verification last time; do not propose them again: ${rejected.join('; ')}` : ''}

Return ONLY JSON in exactly this shape:
{"title": "...", "hook": "...", "thumb": "2 to 4 punchy words for the thumbnail, not a repeat of the title", "segments": [
  {"article": "...", "subject": "...", "topic": "one-line description of this story",
   "angle": "one sentence: what makes this story land", "context": ["year", "club or place"]}
]}`;

  // Generous cap: reasoning models spend part of it before writing any JSON.
  return parseJson(await ai.generateText(prompt, { maxTokens: 6000, temperature: 0.9 }));
}

/** Does the source text itself put this subject in the set? Fails closed. */
async function belongs(ai, title, brief) {
  const prompt = `A documentary compilation is titled "${title}".

Below is the Wikipedia article "${brief.title}". Using ONLY this text, does its
subject clearly belong in that compilation exactly as titled? A person who
caused the event, rather than suffered it, does not belong in a set about
victims. If the text does not establish it, the answer is NO.
"""
${brief.text.slice(0, 4000)}
"""

Answer with one word: YES or NO.`;
  try {
    // Reasoning models spend tokens thinking before they answer; a 10-token cap
    // returned an empty string, which this reads as NO.
    const answer = await ai.generateText(prompt, { maxTokens: 400, temperature: 0 });
    return /^\W*yes\b/i.test(String(answer).trim());
  } catch {
    return false;
  }
}

async function plan(laneName, { dryRun = false } = {}) {
  const lane = LANES.find((l) => l.name.toLowerCase() === String(laneName).toLowerCase());
  if (!lane) throw new Error(`no lane "${laneName}" (have: ${LANES.map((l) => l.name).join(', ')})`);

  const ai = new AITextService({});
  const research = new ResearchService();
  const cover = await coverage(lane);
  const rejected = [];
  // Verified stories carry over between attempts under the same title, and a
  // set that reached two is topped up instead of being discarded (AFTER CACHE
  // verified 2, 3 and 2 stories across three fresh titles and got nothing).
  let held = null;   // { title, hook, thumb, kept }

  for (let attempt = 1; attempt <= 5; attempt++) {
    let proposal;
    try {
      proposal = held
        ? { ...(await propose(ai, lane, cover.avoid, rejected, held.title, held.kept.map((k) => k.brief.title))), title: held.title, hook: held.hook, thumb: held.thumb }
        : await propose(ai, lane, cover.avoid, rejected);
    } catch (error) {
      logger.warn(`attempt ${attempt}: ${error.message}`);
      continue;
    }
    logger.info(`attempt ${attempt}: "${proposal.title}" with ${(proposal.segments || []).length} ${held ? 'more ' : ''}stories`);

    const kept = held ? [...held.kept] : [];
    for (const seg of proposal.segments || []) {
      if (kept.length >= WANT_SEGMENTS) break;
      const subject = String(seg.subject || seg.article || '').replace(/\([^)]*\)/g, '').trim();
      if (!seg.article || !subject) continue;
      if (kept.some((k) => fold(k.brief.title) === fold(seg.article) || fold(k.subject) === fold(subject))) continue;
      if (cover.subjects.has(fold(subject))) {
        logger.info(`  skip "${subject}": already covered`);
        continue;
      }
      const brief = await research.buildBriefFromArticle(seg.article).catch(() => null);
      if (!brief || brief.text.length < MIN_BRIEF_CHARS) {
        logger.info(`  skip "${seg.article}": ${brief ? `brief only ${brief.text.length} chars` : 'no such article'}`);
        rejected.push(seg.article);
        continue;
      }
      // A one-word subject is useless to the Commons search, which requires the
      // whole phrase in a caption: "Bruno" matches every Bruno on Commons.
      if (subject.split(/\s+/).length < 2 && /\(/.test(seg.article)) {
        logger.info(`  skip "${seg.article}": subject "${subject}" is too ambiguous to find photos of`);
        rejected.push(seg.article);
        continue;
      }
      // The model's grasp of who belongs in a set is recall, and recall is what
      // this pipeline does not trust: the first test put a convicted killer in
      // "Every Footballer Who Was Murdered". The brief decides, not the model.
      if (!(await belongs(ai, proposal.title, brief))) {
        logger.info(`  skip "${brief.title}": its article does not support a place in "${proposal.title}"`);
        rejected.push(seg.article);
        continue;
      }
      let id = slug(subject, 24) || slug(seg.article, 24);
      for (let n = 2; cover.ids.has(id) || kept.some((k) => k.id === id); n++) id = `${slug(subject, 21)}-${n}`;
      kept.push({ id, seg, subject, brief });
      await new Promise((r) => setTimeout(r, 1200));   // Wikipedia 429s on bursts
    }

    if (kept.length < MIN_SEGMENTS) {
      if (kept.length >= 2) {
        held = { title: proposal.title, hook: proposal.hook, thumb: proposal.thumb, kept };
        logger.warn(`attempt ${attempt}: ${kept.length} verified stories; topping up "${proposal.title}"`);
      } else {
        held = null;
        logger.warn(`attempt ${attempt}: only ${kept.length} verified stories; re-planning`);
      }
      continue;
    }

    // Cut the id on a word boundary: "every-console-that-was-a-commerci" is not a name.
    let compId = slug(proposal.title, 60);
    if (compId.length > 40) compId = compId.slice(0, 41).replace(/-[^-]*$/, '');
    const defsDir = path.join(ROOT, lane.dataRoot, 'compilations');
    while (await fsp.access(path.join(defsDir, `${compId}.json`)).then(() => true, () => false)) compId += '-2';

    const def = {
      id: compId,
      title: String(proposal.title).slice(0, 95),
      hook: proposal.hook || '',
      thumb: String(proposal.thumb || '').split(/\s+/).slice(0, 4).join(' '),
      plannedAt: new Date().toISOString(),
      plannedBy: 'autopilot',
      segments: kept.map((k) => k.id)
    };

    logger.success(`${compId}: "${def.title}"`);
    kept.forEach((k, i) => logger.info(`  ${i + 1}. ${k.id.padEnd(24)} ${k.brief.title}`));
    if (dryRun) return { def, dryRun: true };

    for (const k of kept) {
      cover.queue.topics.push({
        id: k.id,
        topic: k.seg.topic || k.brief.title,
        angle: k.seg.angle || '',
        keywords: [k.subject, ...(k.seg.context || []).map(String)].slice(0, 4),
        status: 'held',
        attempts: 0,
        voice: lane.voice,
        article: k.brief.title,
        plannedBy: 'autopilot'
      });
      // build-compilation.js reads the brief cache by segment id before it
      // searches, so the verified article is the one the narration comes from.
      await fsp.mkdir(BRIEF_CACHE_DIR, { recursive: true });
      await fsp.writeFile(path.join(BRIEF_CACHE_DIR, `${k.id}.json`), JSON.stringify(k.brief, null, 2));
    }
    await fsp.writeFile(path.join(ROOT, lane.dataRoot, 'queue.json'), JSON.stringify(cover.queue, null, 2));
    await fsp.mkdir(defsDir, { recursive: true });
    await fsp.writeFile(path.join(defsDir, `${compId}.json`), JSON.stringify(def, null, 2));
    return { def };
  }
  throw new Error(`could not plan a verifiable compilation for ${lane.name} in 3 attempts`);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const name = args.find((a) => !a.startsWith('--'));
  plan(name, { dryRun: args.includes('--dry-run') }).catch((error) => {
    logger.error(`plan-compilation failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { plan };
