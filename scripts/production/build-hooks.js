#!/usr/bin/env node
/**
 * HOOK SYSTEM v1 — rewrite every short's opening, style only.
 *
 *   node scripts/build-hooks.js --dry-run     # show old -> new, write nothing
 *   node scripts/build-hooks.js               # write data/hooks/football-files.json
 *   node scripts/build-hooks.js --only foe
 *
 * The measured problem: 50 shorts hold a median 47% average view, which is
 * fine, but none has ever escaped the ~1,200-view test pool and 44,000 views
 * bought 34 subscribers. Retention says the writing works. The opening says
 * nobody had a reason to care yet — every hook opens on a body count, a date
 * or a place ("Ninety-seven people died at a football match"), which is
 * information rather than a reason to keep watching.
 *
 * So this rewrites the opening around ONE person, withholds the outcome, and
 * ends the hook on something unresolved.
 *
 * THE GUARDRAIL IS THE POINT. A style rewrite is exactly where invented detail
 * creeps in — the Ibrox script named "Stairway 13" and two earlier crushes from
 * a source that never mentions stairs. So the brief is the only permitted
 * source, and every rewrite is checked back against it: any number or proper
 * noun absent from the brief is listed in `unverified`, and that hook is held
 * for manual approval rather than shipped.
 */

require('dotenv').config();

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { AITextService } = require('../../utils/ai-text-service');
const { ResearchService } = require('../../utils/research-service');
const { Logger } = require('../../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const DATA_ROOT = process.env.DATA_ROOT || 'data';
const QUEUE_PATH = path.join(ROOT, DATA_ROOT, 'queue.json');
const LEDGER_PATH = path.join(ROOT, DATA_ROOT, 'shorts', 'uploads.json');
const BRIEF_DIR = path.join(ROOT, 'data', 'research', 'briefs');
const OUT_DIR = path.join(ROOT, DATA_ROOT, 'hooks');
const logger = new Logger('BuildHooks');

/**
 * Words that may appear capitalised in a hook without coming from the brief:
 * ordinary English, and the channel's own name.
 */
const ALLOWED = new Set([
  'the', 'a', 'an', 'and', 'but', 'he', 'she', 'they', 'it', 'his', 'her', 'their',
  'what', 'when', 'why', 'how', 'who', 'then', 'still', 'never', 'nobody', 'no', 'one',
  'this', 'that', 'there', 'football', 'files', 'next', 'file', 'minutes', 'seconds',
  'referee', 'doctor', 'doctors', 'crowd', 'match', 'game', 'pitch', 'stadium', 'players',
  'player', 'club', 'team', 'coach', 'fans', 'autopsy', 'broadcast', 'camera', 'cameras'
]);

const fold = (s) => String(s || '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[‐-―−]/g, '-')
  .replace(/,/g, '')
  .toLowerCase();

/**
 * Anything in the rewrite that asserts a fact: numbers, and capitalised words
 * that are not sentence-initial filler. Each must be traceable to the brief.
 */
function unverifiedClaims(text, briefText) {
  const brief = fold(briefText);
  const out = new Set();

  for (const num of fold(text).match(/\d[\d.:]*/g) || []) {
    const clean = num.replace(/[.:]+$/, '');
    if (clean.length > 1 && !brief.includes(clean)) out.add(clean);
  }

  // Strip the leading word of each sentence before hunting proper nouns,
  // otherwise every sentence start reads as a name.
  const body = String(text).replace(/(^|[.!?]\s+)\S+/g, '$1');
  for (const word of body.match(/\b[A-Z][a-zA-Z'-]{2,}\b/g) || []) {
    const w = fold(word);
    if (ALLOWED.has(w)) continue;
    if (!brief.includes(w)) out.add(word);
  }

  return [...out];
}

/**
 * Which still should open the short.
 *
 * Rule 4 wants the most dramatic available frame, never a title card. Commons
 * offers aftermath far more often than incident — statues, memorials, plaques,
 * empty stadiums — because that is what is freely licensed. So this demotes the
 * obvious aftermath words, promotes anything naming the subject, and says
 * plainly when the best available image is still a memorial. That is a cue to
 * source a better still, not a result to accept.
 */
function rankFrames(files, subject) {
  const AFTERMATH = /(statue|memorial|plaque|grave|tomb|commemorat|museum|sign|entrance|reglement|panneau)/i;
  const name = fold(subject).split(/\s+/).filter((w) => w.length > 3);

  const scored = files.map((f) => {
    let score = 0;
    if (name.some((w) => fold(f).includes(w))) score += 3;
    if (AFTERMATH.test(f)) score -= 2;
    if (/\b(19|20)\d\d\b/.test(f)) score += 1;   // dated photo — likely contemporaneous
    return { file: f, score };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  return {
    frame1: best ? best.file : null,
    isAftermath: best ? AFTERMATH.test(best.file) : false,
    ranked: scored.map((s) => s.file)
  };
}

async function briefFor(research, entry) {
  const cached = await fsp.readFile(path.join(BRIEF_DIR, `${entry.id}.json`), 'utf8')
    .then(JSON.parse).catch(() => null);
  if (cached?.text) return cached;

  const keywords = (entry.keywords || []).map(String).filter(Boolean);
  const eventWord = (/(disaster|fire|crush|collapse|crash|riot|stampede|scandal|ruling|murder|death)/i
    .exec(entry.topic || '') || [])[1];
  const candidates = [
    entry.topic,
    eventWord && keywords[0] ? `${keywords[0]} ${eventWord}` : null,
    keywords[0]
  ].filter(Boolean);

  for (const c of candidates) {
    const b = await research.buildBrief(c);
    if (b) {
      await fsp.mkdir(BRIEF_DIR, { recursive: true });
      await fsp.writeFile(path.join(BRIEF_DIR, `${entry.id}.json`), JSON.stringify(b, null, 2));
      return b;
    }
  }
  return null;
}

async function writeHook(ai, entry, brief, nextTopic) {
  const prompt = `Rewrite the opening of a documentary short. STYLE ONLY.

SUBJECT: ${entry.topic}
ANGLE: ${entry.angle || ''}

SOURCE — the only place any fact may come from. If a detail is not here, it does
not go in. Do not add a name, number, date or place that is absent below:
"""
${brief.text.slice(0, 3500)}
"""

Write four things:

1. TITLE — under 90 characters. Centres ONE human being. Never opens with a
   death toll, a date or a place name.
2. LINE1 — the first spoken line, 12 words or fewer. Starts mid-moment: an
   action, a decision, a sound. Not a summary. Not a statistic.
3. CLOSER — one sentence ending the hook on something unresolved. It must
   promise a fact the video will deliver, drawn from the source. The shape:
   "The autopsy said otherwise." / "What the broadcast cut away from was worse."
4. TEASER — under 10 words describing this next subject, for the end card:
   "${nextTopic}"

Hard rules:
- Never reveal the outcome in TITLE or LINE1. Resolution belongs later.
- Every concrete detail must be traceable to the source above.
- No second person. Never "you". No rhetorical questions.
- Plain declarative sentences.

Return exactly this JSON and nothing else:
{"title":"...","line1":"...","closer":"...","teaser":"..."}`;

  const raw = await ai.generateText(prompt, { maxTokens: 500, temperature: 0.8 });
  const match = String(raw).replace(/```(?:json)?/gi, '').match(/\{[\s\S]*\}/);
  if (!match) throw new Error('no JSON in response');
  return JSON.parse(match[0]);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

  const queue = JSON.parse(await fsp.readFile(QUEUE_PATH, 'utf8'));
  const ledger = await fsp.readFile(LEDGER_PATH, 'utf8').then(JSON.parse).catch(() => ({}));

  // The real topics only — `status: 'short'` rows are bookkeeping entries that
  // make-doc-short.js adds for upload metadata, not subjects of their own.
  const topics = queue.topics.filter((t) => t.status !== 'short' && (!only || t.id === only));
  logger.info(`${topics.length} topic(s) to rewrite`);

  const ai = new AITextService({});
  const research = new ResearchService();
  const results = [];

  for (const [i, entry] of topics.entries()) {
    const nextTopic = topics[(i + 1) % topics.length]?.topic || 'another file';
    const oldHook = ledger[entry.id]?.title
      || await fsp.readFile(path.join(ROOT, DATA_ROOT, 'shorts', 'copy', `${entry.id}_short.txt`), 'utf8')
        .then((t) => t.split(/(?<=[.!?])\s+/)[0]).catch(() => null)
      || '(never published)';

    const brief = await briefFor(research, entry);
    if (!brief) {
      logger.warn(`${entry.id}: no brief — cannot rewrite without a source, skipping`);
      results.push({ id: entry.id, topic: entry.topic, oldHook, error: 'no source brief' });
      continue;
    }

    let hook;
    try {
      hook = await writeHook(ai, entry, brief, nextTopic);
    } catch (error) {
      logger.warn(`${entry.id}: ${String(error.message).slice(0, 70)}`);
      results.push({ id: entry.id, topic: entry.topic, oldHook, error: String(error.message).slice(0, 90) });
      continue;
    }

    const imgDir = path.join(ROOT, DATA_ROOT, 'reference', `${entry.id}-archival`);
    const files = fs.existsSync(imgDir)
      ? fs.readdirSync(imgDir).filter((f) => /\.(jpe?g|png)$/i.test(f))
      : [];
    const frames = rankFrames(files, entry.keywords?.[0] || entry.topic);

    const unverified = [
      ...unverifiedClaims(hook.title, brief.text),
      ...unverifiedClaims(hook.line1, brief.text),
      ...unverifiedClaims(hook.closer, brief.text)
    ].filter((v, idx, all) => all.indexOf(v) === idx);

    const words = hook.line1.trim().split(/\s+/).length;
    const flags = [];
    if (words > 12) flags.push(`line1 is ${words} words (limit 12)`);
    if (hook.title.length > 90) flags.push(`title is ${hook.title.length} chars`);
    if (frames.isAftermath) flags.push('best available still is aftermath, not incident');
    if (!files.length) flags.push('no stills downloaded for this topic yet');

    results.push({
      id: entry.id,
      topic: entry.topic,
      source: brief.title,
      oldHook,
      title: hook.title,
      line1: hook.line1,
      closer: hook.closer,
      subHook: `This is Football Files. Next file: ${hook.teaser}`,
      frame1: frames.frame1,
      framesRanked: frames.ranked.slice(0, 4),
      unverified,
      flags,
      approved: false
    });

    const mark = unverified.length ? 'HOLD' : flags.length ? 'warn' : 'ok';
    logger.info(`[${i + 1}/${topics.length}] ${mark.padEnd(4)} ${entry.id}: ${hook.line1.slice(0, 54)}`);
  }

  const held = results.filter((r) => r.unverified?.length).length;
  const failed = results.filter((r) => r.error).length;
  logger.info(`${results.length - held - failed} clean, ${held} held for approval, ${failed} failed`);

  if (dryRun) {
    logger.info('Dry run — nothing written.');
    return results;
  }

  await fsp.mkdir(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, 'football-files.json');
  await fsp.writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), hooks: results }, null, 2));
  logger.success(`${results.length} hook(s) -> ${out}`);
  return results;
}

if (require.main === module) {
  main().catch((error) => {
    logger.error(`build-hooks failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { unverifiedClaims, rankFrames };
