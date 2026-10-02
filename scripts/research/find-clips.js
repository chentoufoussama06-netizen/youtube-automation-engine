#!/usr/bin/env node
/**
 * Point this at one full VOD/stream you have clipping rights to, and it finds
 * the best moments itself instead of you giving timestamps by hand.
 *
 *   node scripts/find-clips.js <youtube-url> --prefix speed [--count 5] [--min 60] [--max 120]
 *
 * Pipeline: download audio only (cheap) -> transcribe the whole thing in
 * chunks via Groq Whisper -> hand the timestamped transcript to the text
 * model and ask for the N most clip-worthy moments -> pull just those
 * ranges from YouTube with yt-dlp's --download-sections (never the full
 * video) -> run each through the exact same trim/vertical/caption/upload
 * pipeline as make-clip.js. Every upload lands private, same as always.
 *
 * Scope this to a channel/creator you actually have rights to — this script
 * doesn't check that for you.
 */

require('dotenv').config();

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { AITextService } = require('../../utils/ai-text-service');
const { transcribeAudioFile } = require('../../utils/transcribe');
const { runFFmpeg } = require('../../utils/ffmpeg');
const { Logger } = require('../../utils/logger');
const clip = require('../production/make-clip');

const execFileAsync = promisify(execFile);
const logger = new Logger('FindClips');

const ROOT = path.join(__dirname, '..', '..');
const CHUNKS_DIR = path.join(ROOT, 'data', 'clips', 'chunks');
const CHUNK_SECONDS = 900; // 15 min — small enough per Whisper call, few enough calls per hour of VOD

function fmtSeconds(s) {
  return String(Math.max(0, Math.round(s)));
}

async function getVideoInfo(url) {
  const { stdout } = await execFileAsync('yt-dlp', ['--dump-json', '--skip-download', url], { maxBuffer: 16 * 1024 * 1024 });
  const info = JSON.parse(stdout);
  return {
    id: info.id, title: info.title, duration: info.duration, uploadDate: info.upload_date,
    creator: info.channel || info.uploader || ''
  };
}

async function downloadFullAudio(url, prefix) {
  const audioPath = path.join(clip.DIRS.audio, `${prefix}_full.mp3`);
  await execFileAsync('yt-dlp', [
    '-f', 'bestaudio', '-x', '--audio-format', 'mp3',
    '-o', audioPath.replace(/\.mp3$/, '.%(ext)s'),
    url
  ], { maxBuffer: 64 * 1024 * 1024 });
  return audioPath;
}

/** Fixed-length segments via ffmpeg's own muxer — fast, no re-encode. */
async function splitAudio(audioPath, prefix) {
  await fsp.mkdir(CHUNKS_DIR, { recursive: true });
  const pattern = path.join(CHUNKS_DIR, `${prefix}_%03d.mp3`);
  await runFFmpeg(['-y', '-i', audioPath, '-f', 'segment', '-segment_time', String(CHUNK_SECONDS), '-c', 'copy', pattern]);
  const files = (await fsp.readdir(CHUNKS_DIR)).filter(f => f.startsWith(`${prefix}_`)).sort();
  return files.map(f => path.join(CHUNKS_DIR, f));
}

/** Transcribe every chunk and stitch into one timeline with real absolute timestamps. */
async function transcribeFull(chunkPaths) {
  const allWords = [];
  let fullText = '';
  for (let i = 0; i < chunkPaths.length; i++) {
    logger.info(`Transcribing chunk ${i + 1}/${chunkPaths.length}...`);
    const offset = i * CHUNK_SECONDS;
    const result = await transcribeAudioFile(chunkPaths[i], { logger });
    if (!result) throw new Error('transcription unavailable (no GROQ_API_KEY)');
    fullText += `${result.text} `;
    for (const w of result.words) allWords.push({ word: w.word, start: w.start + offset, end: w.end + offset });
  }
  return { text: fullText.trim(), words: allWords };
}

/** Word list -> compact "[123s] some words..." lines, ~15 words per line, so a long VOD still fits a prompt. */
function condense(words, wordsPerLine = 15) {
  const lines = [];
  for (let i = 0; i < words.length; i += wordsPerLine) {
    const slice = words.slice(i, i + wordsPerLine);
    if (!slice.length) continue;
    lines.push(`[${Math.round(slice[0].start)}s] ${slice.map(w => w.word).join(' ')}`);
  }
  return lines;
}

const SELECTION_RULES = `You are picking moments from a stream transcript to cut into YouTube Shorts.
The footage is {{CREATOR}}. Pick moments that are genuinely clip-worthy: a big reaction, a
funny or shocking line, a hype spike, an argument, something a viewer would send to a friend.
Skip dead air, filler, and anything that only makes sense with more context than a 20-60
second clip can carry.

Rules:
- Each clip is {{MIN}}-{{MAX}} seconds. Prefer clips that start right before the
  triggering moment, not after it — a clip that opens on the reaction with no setup is confusing.
- Clips must not overlap and should come from different parts of the video, not all clustered
  in one section.
- "title" is a punchy Shorts hook under 12 words, present tense, ONE concrete thing — the same
  bar as: "Ten days after scoring an own goal, he was murdered." Not a vague tease. ALWAYS
  name {{CREATOR}} in the title itself (viewers scrolling Shorts need to know who's in it
  before they'll click) — e.g. "{{CREATOR}} loses it when Messi retires", not just "He loses it".
- "reason" is one short phrase for a human reviewer, not for the title.
- Use the [Ns] timestamps in the transcript as your start/end — pick real numbers from what you see.`;

async function selectCandidates(condensedLines, count, min, max, creator) {
  const service = new AITextService({});
  if (!service.isAvailable()) throw new Error('no AI text provider available for clip selection');

  const rules = SELECTION_RULES.replace(/\{\{CREATOR\}\}/g, creator || 'the creator').replace('{{MIN}}', min).replace('{{MAX}}', max);
  const transcriptBlock = condensedLines.join('\n');
  const budget = 45000; // characters — keep one call inside a safe context window

  const windows = [];
  if (transcriptBlock.length <= budget) {
    windows.push(condensedLines);
  } else {
    const linesPerWindow = Math.ceil(condensedLines.length / Math.ceil(transcriptBlock.length / budget));
    for (let i = 0; i < condensedLines.length; i += linesPerWindow) windows.push(condensedLines.slice(i, i + linesPerWindow));
    logger.info(`Transcript is long — scanning it in ${windows.length} windows.`);
  }

  const perWindowCount = windows.length > 1 ? Math.max(1, Math.ceil((count * 1.5) / windows.length)) : count;
  const all = [];
  for (const [i, win] of windows.entries()) {
    if (windows.length > 1) logger.info(`Scanning window ${i + 1}/${windows.length}...`);
    const prompt = `${rules}\n\nFind up to ${perWindowCount} candidates in this transcript excerpt:\n\n${win.join('\n')}\n\n`
      + 'Return only valid JSON: {"clips": [{"start": 123, "end": 156, "title": "...", "reason": "..."}]}';
    try {
      const raw = await service.generateText(prompt, { maxTokens: 1200, temperature: 0.5, json: true });
      const parsed = JSON.parse(String(raw).replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim().match(/\{[\s\S]*\}/)[0]);
      all.push(...(parsed.clips || []));
    } catch (error) {
      logger.warn(`window ${i + 1} selection failed (${error.message}); skipping it`);
    }
  }

  // Drop anything malformed or out of the requested length band, then take
  // the earliest non-overlapping ones up to `count` — good enough without a
  // second LLM ranking pass, and avoids paying for one on every run.
  const valid = all
    .filter(c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
    .map(c => ({ ...c, start: Math.max(0, c.start), duration: c.end - c.start }))
    .filter(c => c.duration >= min * 0.6 && c.duration <= max * 1.5)
    .sort((a, b) => a.start - b.start);

  const chosen = [];
  for (const c of valid) {
    if (chosen.length >= count) break;
    const last = chosen[chosen.length - 1];
    if (last && c.start < last.end + 5) continue; // too close to the previous pick
    chosen.push(c);
  }
  return chosen;
}

/**
 * yt-dlp's --download-sections relies on ffmpeg seeking mid-stream over the
 * network, and against these googlevideo URLs that reliably hung forever
 * (tested with both AV1 and H.264 source formats — same hang either way, so
 * it's the network seek, not the codec). Downloading the full video once and
 * cutting every candidate locally avoids that path entirely, and it's the
 * same trim step make-clip.js already uses reliably on local files.
 */
async function downloadFullVideo(url, prefix) {
  const rawPath = path.join(clip.DIRS.raw, `${prefix}_full_raw.mp4`);
  logger.info('Downloading full video (once, shared across every candidate)...');
  await execFileAsync('yt-dlp', [
    '-f', 'bv*[vcodec^=avc1][height<=720]+ba[ext=m4a]/b[height<=720][ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '-o', rawPath,
    url
  ], { maxBuffer: 64 * 1024 * 1024 });
  return rawPath;
}

/** Guarantee the creator's name is in the title even if the model forgot — don't rely on the prompt alone. */
function titleWithCreator(title, creator) {
  if (!creator || title.toLowerCase().includes(creator.toLowerCase())) return title;
  return `${creator}: ${title}`;
}

async function makeOneClip(rawPath, sourceUrl, candidate, id, mode, creator) {
  const verticalPath = await clip.trimAndVerticalize(rawPath, id, candidate.start, candidate.end, mode);
  const audioPath = await clip.extractAudio(verticalPath, id);

  let finalPath = verticalPath;
  try {
    const transcript = await clip.transcribe(audioPath); // re-transcribed on just this snippet for tight, accurate caption timing
    if (transcript?.words?.length) finalPath = await clip.burnCaptions(verticalPath, transcript.words, id);
  } catch (error) {
    logger.warn(`[${id}] caption burn failed (${error.message}) — uploading without burned captions.`);
  }

  const metadata = await clip.generateMetadata(null, titleWithCreator(candidate.title, creator), id);
  await clip.upload(finalPath, metadata, id, { source: sourceUrl, start: candidate.start, end: candidate.end });
}

async function main() {
  const args = process.argv.slice(2);
  const url = args.find(a => !a.startsWith('--'));
  const get = (flag, def) => args.includes(flag) ? args[args.indexOf(flag) + 1] : def;
  const prefix = get('--prefix');
  const count = Number(get('--count', '5'));
  const min = Number(get('--min', '60'));
  const max = Number(get('--max', '120'));
  const mode = get('--vertical', 'blur') === 'crop' ? 'crop' : 'blur';

  if (!url || !prefix) {
    throw new Error('usage: node scripts/find-clips.js <youtube-url> --prefix <slug> [--count 5] [--min 20] [--max 60]');
  }

  await clip.ensureDirs();

  const info = await getVideoInfo(url);
  const creator = get('--creator', info.creator);
  logger.info(`"${info.title}" by ${creator} — ${Math.round(info.duration / 60)} min, uploaded ${info.uploadDate}`);

  const audioPath = await downloadFullAudio(url, prefix);
  const chunkPaths = await splitAudio(audioPath, prefix);
  logger.info(`Transcribing ${chunkPaths.length} chunk(s)...`);
  const full = await transcribeFull(chunkPaths);
  logger.info(`Transcript: ${full.words.length} words.`);

  const condensedLines = condense(full.words);
  const candidates = await selectCandidates(condensedLines, count, min, max, creator);
  if (!candidates.length) {
    logger.warn('No candidates survived selection — nothing to clip.');
    return;
  }
  logger.info(`${candidates.length} candidate(s) selected:`);
  candidates.forEach((c, i) => logger.info(
    `  ${i + 1}. ${fmtSeconds(c.start)}s-${fmtSeconds(c.end)}s — "${c.title}" (${c.reason})`
  ));

  const rawPath = await downloadFullVideo(url, prefix);

  for (const [i, candidate] of candidates.entries()) {
    const id = `${prefix}${i + 1}`;
    try {
      await makeOneClip(rawPath, url, candidate, id, mode, creator);
    } catch (error) {
      logger.error(`[${id}] failed: ${error.message}`);
    }
  }

  logger.info('Done. All uploads are private — review them, then '
    + `node scripts/upload-shorts.js --publish ${candidates.map((_, i) => `${prefix}${i + 1}`).join(' ')}`);
}

module.exports = { getVideoInfo, downloadFullVideo, makeOneClip };

if (require.main === module) {
  main().catch(error => {
    logger.error(`find-clips failed: ${error.message}`);
    process.exit(1);
  });
}
