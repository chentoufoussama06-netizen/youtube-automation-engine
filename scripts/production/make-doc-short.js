#!/usr/bin/env node
/**
 * Cut a vertical short out of a finished compilation segment.
 *
 *   node scripts/make-doc-short.js pitch-deaths foe
 *   node scripts/make-doc-short.js pitch-deaths foe --words 100 --id doc-foe
 *
 * Three reasons this exists rather than make-short.js or produce-manual.js.
 *
 * First, it needs no AI text provider. The narration is already written and
 * already checked against a Wikipedia brief by build-compilation.js, so this
 * only trims it. Every provider in the chain is rate-limited or out of credit
 * as of 2026-09-19, and this path does not care.
 *
 * Second, the picture. The existing shorts pair unrelated Pexels stock with a
 * GTA gameplay panel, and measured against the channel's own numbers those
 * shorts hold 32-45% average view while none has ever escaped the ~1,200-view
 * test pool. These use the same licence-verified Commons photographs as the
 * documentary: pictures actually of the person being described. ShortsFactory
 * already supports it through layout:'full', which its own comment describes
 * as "for story-led shorts where borrowed energy is unnecessary".
 *
 * Third, the funnel. RELATED_VIDEO sent the channel 27 views in 28 days and
 * the long-form documentaries have 62 views between them. A short that is
 * literally an excerpt of a documentary gives the viewer somewhere to go.
 */

require('dotenv').config();

const fsp = require('fs').promises;
const path = require('path');
const { ShortsFactory } = require('../../utils/shorts-factory');
const { Logger } = require('../../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const DATA_ROOT = process.env.DATA_ROOT || 'data';
const QUEUE_PATH = process.env.QUEUE_PATH || path.join(ROOT, DATA_ROOT, 'queue.json');
const LEDGER_PATH = path.join(ROOT, DATA_ROOT, 'shorts', 'uploads.json');
const logger = new Logger('MakeDocShort');

const OUT = {
  audio: path.join(ROOT, DATA_ROOT, 'shorts', 'audio'),
  captions: path.join(ROOT, DATA_ROOT, 'shorts', 'captions'),
  copy: path.join(ROOT, DATA_ROOT, 'shorts', 'copy'),
  video: path.join(ROOT, DATA_ROOT, 'shorts', 'video'),
  work: path.join(ROOT, DATA_ROOT, 'shorts', 'work')
};

// Edge TTS reads a short at roughly 150 words per minute. YouTube cuts Shorts
// off at 60 seconds, and one that runs right to the limit loses its ending to
// the loop, so aim at about 45 seconds of speech.
const DEFAULT_WORDS = 110;

const arg = (args, flag, fallback = null) => {
  const i = args.indexOf(flag);
  return i === -1 ? fallback : args[i + 1];
};

/**
 * Trim the segment to the opening it already has.
 *
 * build-compilation.js requires every segment to name its subject in the first
 * sentence, which is what a Shorts title and a Shorts first second both need —
 * so the front of the segment is already the hook and no rewriting is wanted.
 * Cutting on a sentence boundary matters: upload-shorts.js takes the title from
 * the first sentence of the copy file, and half a sentence makes half a title.
 */
function leadingSentences(text, wordBudget) {
  const sentences = text.match(/[^.!?]+[.!?]+(?:["']\s*)?/g) || [text];
  const kept = [];
  let words = 0;

  for (const sentence of sentences) {
    const n = sentence.trim().split(/\s+/).filter(Boolean).length;
    if (words && words + n > wordBudget) break;
    kept.push(sentence.trim());
    words += n;
  }

  if (!kept.length) kept.push(sentences[0].trim());
  return { text: kept.join(' '), words };
}

/** Give the short its own queue entry so the uploader can build real metadata. */
async function registerInQueue(id, source) {
  const queue = JSON.parse(await fsp.readFile(QUEUE_PATH, 'utf8'));
  if (queue.topics.some(t => t.id === id)) return;

  // status 'short' deliberately: upload-private.js only picks up 'done' jobs
  // that carry a videoPath, so this can never be mistaken for a long-form render.
  queue.topics.push({
    id,
    topic: source.topic,
    keywords: source.keywords || [],
    status: 'short',
    sourceCompilation: source.compilation,
    sourceSegment: source.segment
  });
  await fsp.writeFile(QUEUE_PATH, JSON.stringify(queue, null, 2));
  logger.info(`Registered "${id}" in the queue for upload metadata.`);
}

async function main() {
  const args = process.argv.slice(2);
  const [compilation, segmentId] = args.filter(a => !a.startsWith('--'));
  if (!compilation || !segmentId) {
    throw new Error('usage: node scripts/make-doc-short.js <compilation> <segmentId> [--words N] [--id ID]');
  }

  const wordBudget = Number(arg(args, '--words', DEFAULT_WORDS)) || DEFAULT_WORDS;
  const id = arg(args, '--id', `doc-${segmentId}`);

  const docPath = path.join(ROOT, DATA_ROOT, 'scripts', `longform_${compilation}.json`);
  const doc = JSON.parse(await fsp.readFile(docPath, 'utf8'));
  const section = doc.sections.find(s => s.id === segmentId);
  if (!section) {
    throw new Error(`"${segmentId}" is not a section of ${compilation} `
      + `(have: ${doc.sections.map(s => s.id).join(', ')})`);
  }
  if (!section.images?.length) throw new Error(`section "${segmentId}" has no images`);

  // Compilations built before the relevance rule was tightened carry some
  // pictures that are not of their subject at all — the Sala segment holds
  // three Uffizi gallery rooms. Rebuilding those compilations would re-roll
  // narration that is already checked and published, so `--images` picks the
  // usable ones by index instead. `node scripts/make-doc-short.js c s --images 0,3`
  const pick = arg(args, '--images');
  if (pick) {
    const wanted = pick.split(',').map((n) => Number(n.trim())).filter((n) => Number.isInteger(n));
    const chosen = wanted.map((i) => section.images[i]).filter(Boolean);
    if (!chosen.length) throw new Error(`--images ${pick} selected nothing from ${section.images.length} image(s)`);
    logger.info(`Using ${chosen.length} of ${section.images.length} image(s): ${chosen.map((c) => c.slice(0, 40)).join(', ')}`);
    section.images = chosen;
  }

  // Refuse to make a second short about a subject the channel has already
  // covered. Every one of the first eleven cut from these compilations turned
  // out to duplicate a short already public since August — the ledger was open
  // in the same session and simply not consulted. Near-identical reuploads are
  // the reused-content pattern YouTube throttles, which is the last thing a
  // channel already losing distribution needs.
  const ledger = await fsp.readFile(LEDGER_PATH, 'utf8').then(JSON.parse).catch(() => ({}));
  const existing = ledger[segmentId] || ledger[id];
  if (existing && !args.includes('--force')) {
    throw new Error(`"${segmentId}" is already on the channel as ${existing.url} `
      + `(${existing.privacyStatus}, uploaded ${String(existing.uploadedAt).slice(0, 10)}) — `
      + `"${String(existing.title).slice(0, 60)}". Pick another segment, or pass --force `
      + 'if you intend to replace it and will unlist the old one.');
  }

  for (const dir of Object.values(OUT)) await fsp.mkdir(dir, { recursive: true });

  const { text, words } = leadingSentences(section.text, wordBudget);
  logger.info(`${id}: ${words} words from ${compilation}/${segmentId}`);
  logger.info(`Hook: "${text.split(/(?<=[.!?])\s+/)[0]}"`);

  const queue = JSON.parse(await fsp.readFile(QUEUE_PATH, 'utf8'));
  const sourceJob = queue.topics.find(t => t.id === segmentId) || {};

  const factory = new ShortsFactory({});
  const voice = sourceJob.voice || process.env.EDGE_TTS_VOICE || 'en-GB-RyanNeural';
  const audioPath = path.join(OUT.audio, `${id}_short.mp3`);
  const narration = await factory.narrateWithTiming(text, voice, audioPath);
  const seconds = await factory.probeDuration(audioPath);
  logger.info(`Narration: ${seconds.toFixed(1)}s in ${voice}`);
  if (seconds > 60) {
    throw new Error(`${seconds.toFixed(0)}s exceeds the 60s Shorts limit — re-run with a smaller --words`);
  }

  const captionPath = path.join(OUT.captions, `${id}_short.ass`);
  await fsp.writeFile(captionPath, factory.buildCaptions(narration.words));

  // One clip per photograph, splitting the narration evenly between them.
  const imgDir = path.join(ROOT, DATA_ROOT, 'reference', `${compilation}-archival`);
  const per = seconds / section.images.length;
  const storyClips = [];
  for (const [i, file] of section.images.entries()) {
    const clipPath = path.join(OUT.work, `${id}_${i}.mp4`);
    await factory.stillToClip(path.join(imgDir, file), per, clipPath);
    storyClips.push(clipPath);
    logger.info(`still ${i + 1}/${section.images.length}: ${per.toFixed(1)}s`);
  }

  const outputPath = path.join(OUT.video, `${id}_short.mp4`);
  await factory.renderShort({
    storyClips,
    motionClip: null,          // no gameplay panel — see the header
    layout: 'full',
    audioPath,
    captionPath,
    outputPath
  });

  // upload-shorts.js titles the video with the first sentence of this file. The
  // segment's own opening names the subject, which is the half of the job that
  // matters, but it opens like a documentary rather than like a title — the
  // channels winning this niche lead on a curiosity gap. `--hook` puts one in
  // front. It must stay true to the narration: it is a headline for the same
  // story, never a claim the video does not make.
  const hook = arg(args, '--hook');
  const copy = hook ? `${hook.replace(/\s+$/, '')} ${text}` : text;
  await fsp.writeFile(path.join(OUT.copy, `${id}_short.txt`), copy);
  if (hook) logger.info(`Title will be: "${hook}"`);
  await registerInQueue(id, {
    topic: sourceJob.topic || section.title || segmentId,
    keywords: sourceJob.keywords || doc.keywords,
    compilation,
    segment: segmentId
  });

  await Promise.all(storyClips.map(p => fsp.unlink(p).catch(() => {})));

  const stat = await fsp.stat(outputPath);
  logger.success(`${id}: ${Math.round(stat.size / 1048576)} MB, ${seconds.toFixed(0)}s -> ${outputPath}`);
  logger.info('Upload it: node scripts/upload-shorts.js');
}

if (require.main === module) {
  main().catch(error => {
    logger.error(`make-doc-short failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { leadingSentences };
