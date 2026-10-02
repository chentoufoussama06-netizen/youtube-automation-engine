#!/usr/bin/env node
/**
 * Render a short from a HAND-WRITTEN script + copy, bypassing every AI text
 * call in the normal pipeline (script writing, short compression, fact-check,
 * visual query generation). For when every configured AI text provider is
 * down but narration (Edge TTS, no key needed) and footage (Pexels) are not.
 *
 *   node scripts/produce-manual.js vichai
 *
 * Expects data/scripts/manual_<jobId>.json shaped like:
 *   { script: {...same schema ScriptWriterAgent normally writes...},
 *     short: { hook, lines, fullText, wordCount },
 *     queries: ["...", ...] }             // hand-picked Pexels search terms
 *
 * Mirrors make-short.js's non-AI-text steps exactly, so the output lands in
 * the same directories with the same naming — upload-shorts.js and every
 * other downstream tool can't tell the difference.
 */

require('dotenv').config();

const fsp = require('fs').promises;
const path = require('path');
const { ShortsFactory, MOTION_QUERIES } = require('../../utils/shorts-factory');
const { AIVideoGenerator } = require('../../utils/ai-video-generator');
const { Logger } = require('../../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const DATA_ROOT = process.env.DATA_ROOT || 'data';
const QUEUE_PATH = process.env.QUEUE_PATH || path.join(ROOT, DATA_ROOT, 'queue.json');
const SHORTS_DIR = path.join(ROOT, DATA_ROOT, 'shorts');
const SCRIPTS_DIR = path.join(ROOT, DATA_ROOT, 'scripts');
const OUT = {
  video: path.join(SHORTS_DIR, 'video'),
  audio: path.join(SHORTS_DIR, 'audio'),
  captions: path.join(SHORTS_DIR, 'captions'),
  copy: path.join(SHORTS_DIR, 'copy')
};
const logger = new Logger('ProduceManual');

async function findGameplaySource() {
  const dir = path.join(ROOT, 'data', 'gameplay');
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch (error) {
    return null;
  }
  const videos = entries.filter(f => /\.(mp4|mov|mkv|webm)$/i.test(f));
  if (!videos.length) return null;
  const sized = await Promise.all(videos.map(async f => {
    const full = path.join(dir, f);
    return { full, size: (await fsp.stat(full)).size };
  }));
  sized.sort((a, b) => b.size - a.size);
  return sized[0].full;
}

async function main() {
  const jobId = process.argv[2];
  if (!jobId) throw new Error('usage: node scripts/produce-manual.js <jobId>');

  const manualPath = path.join(SCRIPTS_DIR, `manual_${jobId}.json`);
  const manual = JSON.parse(await fsp.readFile(manualPath, 'utf8'));
  const { script, short, queries } = manual;

  const queue = JSON.parse(await fsp.readFile(QUEUE_PATH, 'utf8'));
  const job = queue.topics.find(j => j.id === jobId);
  if (!job) throw new Error(`no job "${jobId}" in the queue`);

  for (const dir of Object.values(OUT)) await fsp.mkdir(dir, { recursive: true });
  await fsp.mkdir(SCRIPTS_DIR, { recursive: true });

  // Saved in the normal place under the normal naming so a later long-form
  // render (or any tool that reads job.scriptPath) finds it exactly like an
  // AI-written one — the only difference is who wrote the words.
  const scriptPath = path.join(SCRIPTS_DIR, `${Date.now()}_script.json`);
  await fsp.writeFile(scriptPath, JSON.stringify(script, null, 2));
  job.scriptPath = scriptPath;
  await fsp.writeFile(QUEUE_PATH, JSON.stringify(queue, null, 2));
  logger.info(`Script saved: "${script.title}"`);

  const finalText = short.fullText;
  logger.info(`Short: ${short.wordCount} words, hook = "${short.hook}"`);
  await fsp.writeFile(path.join(OUT.copy, `${jobId}_short.txt`), finalText);

  const factory = new ShortsFactory({});
  const voice = job.voice || process.env.EDGE_TTS_VOICE || 'en-GB-RyanNeural';
  const audioPath = path.join(OUT.audio, `${jobId}_short.mp3`);
  const narration = await factory.narrateWithTiming(finalText, voice, audioPath);
  const seconds = await factory.probeDuration(audioPath);
  logger.info(`Narration: ${seconds.toFixed(1)}s in ${voice}`);
  if (seconds > 60) logger.warn(`${seconds.toFixed(0)}s exceeds the 60s Shorts limit — shorten and re-run`);

  const captionPath = path.join(OUT.captions, `${jobId}_short.ass`);
  await fsp.writeFile(captionPath, factory.buildCaptions(narration.words));

  const generator = new AIVideoGenerator({});
  const storyClips = [];
  for (const query of queries) {
    try {
      const clip = await generator.fetchPexelsClipCached(query, 'portrait');
      if (clip) storyClips.push(clip);
    } catch (error) {
      logger.warn(`story clip "${query}" failed: ${String(error.message).slice(0, 60)}`);
    }
  }
  if (!storyClips.length) throw new Error('no story clips could be sourced');

  let motionClip = null;
  let motionStart = 0;
  const source = await findGameplaySource();
  if (source) {
    try {
      motionStart = await factory.pickGameplayWindow(source, seconds);
      motionClip = source;
      logger.info(`Motion panel: ${path.basename(source)} @ ${motionStart.toFixed(0)}s`);
    } catch (error) {
      logger.warn(`gameplay source unusable (${String(error.message).slice(0, 70)})`);
    }
  }
  if (!motionClip) {
    const query = MOTION_QUERIES[Math.floor(Math.random() * MOTION_QUERIES.length)];
    try {
      motionClip = await generator.fetchPexelsClipCached(query, 'portrait');
      logger.info(`Motion panel (stock fallback): "${query}"`);
    } catch (error) {
      logger.warn(`motion clip failed (${String(error.message).slice(0, 50)}); using full-frame`);
    }
  }

  const outputPath = path.join(OUT.video, `${jobId}_short.mp4`);
  await factory.renderShort({
    storyClips, motionClip, motionStart, audioPath, captionPath, outputPath,
    layout: motionClip ? 'split' : 'full'
  });
  const stat = await fsp.stat(outputPath);
  logger.success(`${jobId}: rendered (${Math.round(stat.size / 1048576)} MB, ${seconds.toFixed(0)}s)`);
}

main().catch(error => {
  logger.error(`produce-manual failed: ${error.message}`);
  process.exit(1);
});
