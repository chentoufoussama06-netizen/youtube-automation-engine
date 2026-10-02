#!/usr/bin/env node
/**
 * Turn a licensed source video (a streamer VOD, a sports-reaction stream —
 * anything you have clipping rights to) into a captioned vertical short and
 * upload it, private, next to the rest of the channel's shorts.
 *
 *   node scripts/make-clip.js <youtube-url-or-local-file> --id speed-nba1 \
 *     --start 12:34 --end 13:22 [--title "..."] [--vertical crop|blur] [--focus center|left|right]
 *
 * This does NOT fetch anything from a source you don't already have the right
 * to use. A YouTube URL is downloaded with yt-dlp; a local file path (e.g.
 * something already pulled from a Drive folder a program handed you) is used
 * as-is. Google Drive links aren't fetched automatically — download those by
 * hand and pass the local path instead.
 *
 * Output lands in data/shorts/video/<id>_short.mp4, the exact convention the
 * AI-narration pipeline uses, and the upload is recorded in the same
 * data/shorts/uploads.json ledger — so `upload-shorts.js --publish <id>` and
 * `scripts/analytics.js` work on a clip exactly like they do on a documentary
 * short. It's tagged `source: "clip"` in the ledger so the two are still
 * distinguishable later.
 *
 * Every upload is private, same rule as upload-shorts.js: publishing is a
 * separate, deliberate step, not a side effect of processing.
 */

require('dotenv').config();

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { google } = require('googleapis');
const { runFFmpeg, ffmpegInstallHint } = require('../../utils/ffmpeg');
const { ShortsFactory } = require('../../utils/shorts-factory');
const { AITextService } = require('../../utils/ai-text-service');
const { transcribeAudioFile } = require('../../utils/transcribe');
const { Logger } = require('../../utils/logger');

const execFileAsync = promisify(execFile);
const logger = new Logger('MakeClip');

const ROOT = path.join(__dirname, '..', '..');
// DATA_ROOT/YT_TOKENS_FILE — the same pair upload-shorts.js honours.
//
// These were hardcoded to data/shorts and config/tokens.json, so a clip built
// with DATA_ROOT=data/clips-channel still uploaded to Football Files and still
// wrote to Football Files' ledger. That is how 49 streamer clips ended up on
// the football channel, and it happened again today with a Boxabl clip. The
// env vars now actually select the channel.
const DATA_ROOT = process.env.DATA_ROOT || 'data';
const YT_TOKENS_FILE = process.env.YT_TOKENS_FILE || 'tokens.json';
const DIRS = {
  raw: path.join(ROOT, 'data', 'clips', 'raw'),
  vertical: path.join(ROOT, 'data', 'clips', 'vertical'),
  audio: path.join(ROOT, 'data', 'clips', 'audio'),
  captions: path.join(ROOT, DATA_ROOT, 'shorts', 'captions'),
  video: path.join(ROOT, DATA_ROOT, 'shorts', 'video')
};
const LEDGER_PATH = path.join(ROOT, DATA_ROOT, 'shorts', 'uploads.json');

function authorize() {
  const creds = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'credentials.json'), 'utf8')).youtube;
  const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', YT_TOKENS_FILE), 'utf8')).youtube;
  const oauth = new google.auth.OAuth2(creds.client_id, creds.client_secret, (creds.redirect_uris || [])[0]);
  oauth.setCredentials(tokens);
  return google.youtube({ version: 'v3', auth: oauth });
}

/** "12:34", "1:02:03" or a raw seconds string -> seconds. */
function parseTime(str) {
  if (/^\d+(\.\d+)?$/.test(str)) return Number(str);
  const parts = str.split(':').map(Number);
  if (parts.some(Number.isNaN)) throw new Error(`bad timestamp: "${str}"`);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/**
 * FFmpeg's subtitles filter parses ":" and "\" as its own syntax — see the
 * identical problem (and fix) in ShortsFactory._escapeForFilter.
 */
function escapeForFilter(filePath) {
  const relative = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
  if (relative && !relative.startsWith('..')) return relative;
  return filePath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');
}

async function ensureDirs() {
  for (const dir of Object.values(DIRS)) await fsp.mkdir(dir, { recursive: true });
}

async function downloadSource(source, id) {
  if (/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(source)) {
    const rawPath = path.join(DIRS.raw, `${id}_raw.mp4`);
    logger.info(`Downloading via yt-dlp: ${source}`);
    await execFileAsync('yt-dlp', [
      '-f', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '-o', rawPath,
      source
    ], { maxBuffer: 64 * 1024 * 1024 });
    return rawPath;
  }
  if (/drive\.google\.com/.test(source)) {
    throw new Error('Drive links aren\'t fetched automatically — download it by hand and pass the local file path instead.');
  }
  // Anything else is treated as a local path already on disk.
  await fsp.access(source);
  return source;
}

/**
 * Trim the moment out of the source and make it 9:16.
 *
 * `crop` fills the frame: the picture is scaled up until it covers 1080x1920
 * and the sides are cut away. `blur` keeps the whole 16:9 picture and floats it
 * over a blurred copy of itself, so the real footage occupies a band about a
 * third of the screen high with dead bars above and below.
 *
 * blur used to be the default and that was the wrong call. On a phone the
 * subject ends up too small to read, and every clip channel this competes with
 * fills the screen. crop is the default now; blur stays for footage where the
 * edges genuinely carry the moment.
 *
 * `focus` slides the crop window sideways, because the action in stream and
 * bodycam footage is often off-centre and a dead-centre crop can cut the person
 * out of their own clip.
 */
async function trimAndVerticalize(rawPath, id, start, end, mode, focus = 'center') {
  const outPath = path.join(DIRS.vertical, `${id}_vertical.mp4`);

  // crop's x counts from the left of the scaled-up image, and (iw-ow) is how
  // much width there is to give away.
  const xExpr = { left: '0', right: '(iw-ow)', center: '(iw-ow)/2' }[focus] || '(iw-ow)/2';

  const vf = mode === 'crop'
    ? `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:${xExpr}:(ih-oh)/2,format=yuv420p`
    : 'split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,'
      + 'crop=1080:1920,gblur=sigma=20[bg2];[fg]scale=1080:1920:force_original_aspect_ratio=decrease[fg2];'
      + '[bg2][fg2]overlay=(W-w)/2:(H-h)/2,format=yuv420p';

  logger.info(`Trimming ${start.toFixed(1)}s-${end.toFixed(1)}s and converting to 9:16 (${mode})...`);
  await runFFmpeg([
    '-y', '-ss', String(start), '-to', String(end), '-i', rawPath,
    '-vf', vf, '-r', '30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19',
    '-c:a', 'aac', '-b:a', '160k',
    outPath
  ]);
  return outPath;
}

async function extractAudio(verticalPath, id) {
  const audioPath = path.join(DIRS.audio, `${id}.mp3`);
  await runFFmpeg(['-y', '-i', verticalPath, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'libmp3lame', '-q:a', '4', audioPath]);
  return audioPath;
}

/** Real speech-to-text on the clip's own audio — nothing here is pre-scripted like the AI-narration pipeline. */
async function transcribe(audioPath) {
  return transcribeAudioFile(audioPath, { logger });
}

async function burnCaptions(verticalPath, words, id) {
  const factory = new ShortsFactory({ logger });
  const ass = factory.buildCaptions(words, { wordsPerChunk: 3, fontSize: 96, marginV: 700 });
  const assPath = path.join(DIRS.captions, `${id}_short.ass`);
  await fsp.writeFile(assPath, ass);

  const finalPath = path.join(DIRS.video, `${id}_short.mp4`);
  await runFFmpeg([
    '-y', '-i', verticalPath,
    '-vf', `subtitles='${escapeForFilter(assPath)}'`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-c:a', 'copy',
    finalPath
  ]);
  return finalPath;
}

async function generateMetadata(transcriptText, explicitTitle, id) {
  const SUFFIX = ' #Shorts';
  if (explicitTitle) {
    return { title: `${explicitTitle.slice(0, 100 - SUFFIX.length)}${SUFFIX}`, description: explicitTitle, tags: [] };
  }
  const service = new AITextService({});
  if (!transcriptText || !service.isAvailable()) {
    return { title: `${id}${SUFFIX}`, description: transcriptText || id, tags: [] };
  }
  const prompt = 'This is a transcript of a short vertical clip cut from a stream. Write ONE punchy '
    + 'YouTube Shorts title under 12 words that hooks on the funniest or most shocking single moment '
    + '(no spoiling the whole thing), plus 5 relevant lowercase hashtags (no spaces, no leading text). '
    + `Transcript:\n"""${transcriptText.slice(0, 1200)}"""\n\n`
    + 'Return only valid JSON: {"title": "...", "hashtags": ["...", "..."]}';
  try {
    const raw = await service.generateText(prompt, { maxTokens: 300, temperature: 0.6, json: true });
    const parsed = JSON.parse(String(raw).replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim().match(/\{[\s\S]*\}/)[0]);
    const title = `${String(parsed.title).slice(0, 100 - SUFFIX.length)}${SUFFIX}`;
    const tags = (parsed.hashtags || []).map(h => String(h).replace(/^#/, ''));
    return { title, description: `${transcriptText.slice(0, 400)}\n\n${tags.map(t => `#${t}`).join(' ')}`, tags };
  } catch (error) {
    logger.warn(`title generation failed (${error.message}); falling back to a plain title`);
    return { title: `${id}${SUFFIX}`, description: transcriptText.slice(0, 400), tags: [] };
  }
}

async function upload(finalPath, metadata, id, sourceMeta) {
  const youtube = authorize();
  const sizeMb = Math.round((await fsp.stat(finalPath)).size / 1048576);
  logger.info(`Uploading ${id} (${sizeMb} MB)...`);

  const res = await youtube.videos.insert({
    part: 'snippet,status',
    requestBody: {
      snippet: {
        title: metadata.title,
        description: metadata.description,
        tags: metadata.tags.slice(0, 15),
        categoryId: '17', // Sports
        defaultLanguage: 'en',
        defaultAudioLanguage: 'en'
      },
      status: { privacyStatus: 'private', selfDeclaredMadeForKids: false }
    },
    media: { body: fs.createReadStream(finalPath) }
  });

  const ledger = JSON.parse(await fsp.readFile(LEDGER_PATH, 'utf8').catch(() => '{}'));
  ledger[id] = {
    videoId: res.data.id,
    url: `https://www.youtube.com/watch?v=${res.data.id}`,
    privacyStatus: res.data.status?.privacyStatus || 'private',
    title: metadata.title,
    uploadedAt: new Date().toISOString(),
    source: 'clip',
    sourceUrl: sourceMeta.source,
    clipRange: { start: sourceMeta.start, end: sourceMeta.end }
  };
  await fsp.writeFile(LEDGER_PATH, JSON.stringify(ledger, null, 2));
  logger.success(`${id} -> ${ledger[id].url} (private)`);
  logger.info(`Review it, then: node scripts/upload-shorts.js --publish ${id}`);
}

async function main() {
  const args = process.argv.slice(2);
  const source = args.find(a => !a.startsWith('--'));
  const get = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
  const id = get('--id');
  const startArg = get('--start');
  const endArg = get('--end');
  const title = get('--title');
  // crop by default: fill the frame. Pass --vertical blur to letterbox instead.
  const mode = get('--vertical') === 'blur' ? 'blur' : 'crop';
  const focus = get('--focus') || 'center';
  const stingerPath = get('--stinger');
  const punchAtArg = get('--punch-at');

  if (!source || !id || !startArg || !endArg) {
    throw new Error('usage: node scripts/make-clip.js <url-or-file> --id <slug> --start <t> --end <t> '
      + '[--title "..."] [--vertical crop|blur] [--focus center|left|right] [--stinger <audio-path> --punch-at <t-within-clip>]');
  }
  const start = parseTime(startArg);
  const end = parseTime(endArg);
  if (end <= start) throw new Error('--end must be after --start');
  if (stingerPath && !punchAtArg) throw new Error('--stinger requires --punch-at (seconds from the start of the clip, not the source)');
  const punchAt = punchAtArg ? parseTime(punchAtArg) : null;

  await ensureDirs();

  const rawPath = await downloadSource(source, id);
  const verticalPath = await trimAndVerticalize(rawPath, id, start, end, mode, focus);
  const audioPath = await extractAudio(verticalPath, id);

  let finalPath = verticalPath;
  let transcript = null;
  try {
    transcript = await transcribe(audioPath);
    if (transcript?.words?.length) {
      finalPath = await burnCaptions(verticalPath, transcript.words, id);
    } else {
      logger.warn('No usable transcript — uploading without burned captions.');
    }
  } catch (error) {
    logger.warn(`Transcription/caption burn failed (${error.message}) — uploading without burned captions.`);
  }

  if (stingerPath) {
    const { applyPunch } = require('../../utils/punch-effect');
    const punchedPath = path.join(DIRS.video, `${id}_punched.mp4`);
    logger.info(`Punching in at ${punchAt.toFixed(2)}s with stinger ${stingerPath}...`);
    await applyPunch(finalPath, punchedPath, { punchAtSec: punchAt, stingerPath });
    finalPath = punchedPath;
  }

  const metadata = await generateMetadata(transcript?.text, title, id);
  await upload(finalPath, metadata, id, { source, start, end });
}

module.exports = {
  DIRS, LEDGER_PATH, authorize, parseTime, escapeForFilter, ensureDirs,
  downloadSource, trimAndVerticalize, extractAudio, transcribe, burnCaptions,
  generateMetadata, upload
};

if (require.main === module) {
  main().catch(error => {
    logger.error(`make-clip failed: ${error.message}`);
    if (/ffmpeg/i.test(error.message)) logger.error(ffmpegInstallHint());
    process.exit(1);
  });
}
