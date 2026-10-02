#!/usr/bin/env node
/**
 * Assemble a long-form documentary from a hand-written script and real,
 * license-cleared photos (see utils/archival-images.js) — a Ken Burns
 * pan/zoom treatment on real images, not AI-generated "archival style" stills.
 * Bypasses AI text generation entirely, same reasoning as produce-manual.js.
 *
 *   node scripts/produce-longform.js kobe
 *   node scripts/produce-longform.js kobe --fresh   # ignore anything kept from a stopped run
 *
 * Expects data/scripts/longform_<jobId>.json:
 *   { title, keywords, angle,
 *     sections: [{ id, title, images: ["file.jpg", ...], text }] }
 * Images are read from data/reference/<jobId>-archival/.
 *
 * Section start times are cued from the real narration word-timing stream
 * (same technique as build-documentary.js's cueTime), not guessed durations —
 * so the picture always changes exactly when the story does.
 */

require('dotenv').config();

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { ShortsFactory } = require('../../utils/shorts-factory');
const { runFFmpeg } = require('../../utils/ffmpeg');
const { Logger } = require('../../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const DATA_ROOT = process.env.DATA_ROOT || 'data';
const logger = new Logger('ProduceLongform');

function cueTime(words, phrase) {
  const target = phrase.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean).slice(0, 6);
  const flat = words.map(w => w.word.toLowerCase().replace(/[^a-z0-9]/g, ''));
  for (let i = 0; i <= flat.length - target.length; i++) {
    if (target.every((t, j) => flat[i + j] === t)) return words[i].start;
  }
  return null;
}

function toSrtTime(seconds) {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function buildSrt(words) {
  const sentences = [];
  let acc = [];
  for (const w of words) {
    acc.push(w);
    if (/[.!?]["']?$/.test(w.word)) {
      sentences.push(acc);
      acc = [];
    }
  }
  if (acc.length) sentences.push(acc);
  return sentences.map((sent, i) => {
    const start = sent[0].start;
    const end = sent[sent.length - 1].end;
    const text = sent.map(w => w.word).join(' ');
    return `${i + 1}\n${toSrtTime(start)} --> ${toSrtTime(end)}\n${text}\n`;
  }).join('\n');
}

/**
 * Flatten one source image into the two plates a clip is composed from, once.
 *
 * This is the whole performance story. With `-loop 1` straight off a JPEG,
 * ffmpeg re-runs the entire filter chain for every output frame, so a
 * 1920x4013 Commons photo was being rescaled 900 times for a 30-second clip.
 * Measured on this machine: 111 seconds that way, 14 seconds from pre-scaled
 * plates. Doing it once here is what brought a ten-minute render back under
 * real time.
 */
async function buildPlates(imagePath, workDir, key) {
  const fgPath = path.join(workDir, `${key}_fg.png`);
  const bgPath = path.join(workDir, `${key}_bg.png`);
  const bgW = Math.round(1920 * 1.15 / 2) * 2;
  const bgH = Math.round(1080 * 1.15 / 2) * 2;

  await runFFmpeg([
    '-y', '-i', imagePath,
    '-vf', 'scale=1920:1012:force_original_aspect_ratio=decrease',
    '-frames:v', '1', fgPath
  ]);

  // The blur is a round trip through 256px rather than boxblur, which at a
  // radius wide enough to look right cost more than the encode did.
  await runFFmpeg([
    '-y', '-i', imagePath,
    '-vf', 'scale=256:144:force_original_aspect_ratio=increase,crop=256:144,'
      + `scale=${bgW}:${bgH}:flags=bilinear,eq=brightness=-0.18:saturation=0.55`,
    '-frames:v', '1', bgPath
  ]);

  return { fgPath, bgPath, bgW, bgH };
}

/**
 * One moving clip from a still image: the whole picture, centred over a blurred
 * enlargement of itself, with the plate panning behind it.
 *
 * The obvious implementation is zoompan, and that is what this was. zoompan
 * holds its scaled source for the whole `d=` window — a 25-second still at
 * 1920x1080 is 750 buffered frames — which is also why the shorts pipeline
 * stopped using it. crop+overlay over pre-built plates streams instead.
 *
 * `drift` varies the pan direction and float period per image so a section made
 * of four stills does not feel like it is on rails.
 */
async function buildImageClip(imagePath, duration, outPath, drift = 0) {
  const progress = `min(t/${Math.max(0.1, duration).toFixed(2)},1)`;

  // Commons stock is mostly NOT 16:9 — of the images sourced for the first
  // compilation one was 1920x4013 and most of the rest were 4:3, and cropping
  // those to fill the frame cost the subject his head. So the subject is always
  // CONTAINED, never cropped, over a blurred enlargement of itself.
  //
  // An earlier version branched on the image's aspect ratio, read via ffprobe.
  // That silently did nothing useful: ffmpeg-static ships ffmpeg.exe and no
  // ffprobe.exe, so every probe threw, every image fell back to the assumed
  // 16:9, and every image took the cropping path anyway. One path that is
  // correct for all aspect ratios is better than a branch that needs a binary
  // this project does not have.
  const workDir = path.dirname(outPath);
  const key = path.basename(outPath, path.extname(outPath));
  const { fgPath, bgPath, bgH } = await buildPlates(imagePath, workDir, key);

  const bgTravel = Math.round(1920 * 1.15 / 2) * 2 - 1920;
  const dir = drift % 2 ? `(1-${progress})` : progress;

  // The motion lives in the blurred plate, which is oversized and pans across,
  // plus a slow float on the subject. Both operate on plates that are already
  // the right size, so each frame is a crop and an overlay and nothing else.
  const float = `${8 + (drift % 3) * 4}*sin(2*PI*t/${11 + (drift % 4)})`;

  await runFFmpeg([
    '-y',
    '-loop', '1', '-t', String(duration), '-i', bgPath,
    '-loop', '1', '-t', String(duration), '-i', fgPath,
    '-filter_complex',
    `[0:v]crop=1920:1080:x='(${bgTravel})*${dir}':y='(${bgH - 1080})/2'[b];`
    + `[b][1:v]overlay=x='(W-w)/2+${float}':y='(H-h)/2',fps=30,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-threads', '2',
    outPath
  ]);

  await Promise.all([fsp.unlink(fgPath), fsp.unlink(bgPath)].map((p) => p.catch(() => {})));
}

async function main() {
  const jobId = process.argv[2];
  if (!jobId) throw new Error('usage: node scripts/produce-longform.js <jobId>');

  const doc = JSON.parse(await fsp.readFile(path.join(ROOT, DATA_ROOT, 'scripts', `longform_${jobId}.json`), 'utf8'));
  const imgDir = path.join(ROOT, DATA_ROOT, 'reference', `${jobId}-archival`);
  const dirs = {
    audio: path.join(ROOT, DATA_ROOT, 'audio'),
    captions: path.join(ROOT, DATA_ROOT, 'captions'),
    video: path.join(ROOT, DATA_ROOT, 'videos'),
    segments: path.join(ROOT, DATA_ROOT, 'production', `${jobId}-segments`)
  };
  for (const d of Object.values(dirs)) await fsp.mkdir(d, { recursive: true });

  // A ten-minute render is long enough that this machine's low-memory guard
  // kills it partway through — it happened three times building the first
  // compilation. So the run is resumable: narration and every finished segment
  // are kept, and re-running picks up where it stopped. `--fresh` starts over.
  const fresh = process.argv.includes('--fresh');

  const fullText = doc.sections.map(s => s.text).join(' ');
  const factory = new ShortsFactory({});
  const audioPath = path.join(dirs.audio, `${jobId}_longform.mp3`);
  const wordsPath = path.join(dirs.audio, `${jobId}_longform.words.json`);

  // The narration must be byte-identical across resumes: section boundaries are
  // cued from its word timings, so re-narrating would shift every boundary and
  // leave the already-rendered segments running against the wrong audio.
  // The cache is keyed on the script's text, not just the job id. Without that
  // a rebuilt script would be rendered against the PREVIOUS run's audio — the
  // segments would look right, the narration would be the old words, and
  // nothing would report an error.
  const scriptHash = crypto.createHash('sha1').update(fullText).digest('hex').slice(0, 12);

  let narration = null;
  if (!fresh) {
    const cached = await fsp.readFile(wordsPath, 'utf8').then(JSON.parse).catch(() => null);
    const haveAudio = await fsp.stat(audioPath).then(s => s.size > 0).catch(() => false);
    if (cached?.words?.length && haveAudio && cached.scriptHash === scriptHash) {
      narration = { words: cached.words };
      logger.info(`Reusing cached narration (${cached.words.length} word timings).`);
    } else if (cached && cached.scriptHash !== scriptHash) {
      logger.info('Script changed since the last run — re-narrating and rebuilding every segment.');
    }
  }
  if (!narration) {
    logger.info(`Narrating ${fullText.split(/\s+/).length} words...`);
    narration = await factory.narrateWithTiming(fullText, process.env.EDGE_TTS_VOICE || 'en-US-ChristopherNeural', audioPath);
    await fsp.writeFile(wordsPath, JSON.stringify({ scriptHash, words: narration.words }));
  }

  const totalDuration = await factory.probeDuration(audioPath);
  logger.info(`Narration: ${totalDuration.toFixed(1)}s (${(totalDuration / 60).toFixed(1)} min)`);

  // Where each section's picture should change.
  //
  // Phrase matching against the real word timings is exact when it works, but
  // it does not always work — "On November 12, 1996, the Charkhi Dadri mid-air"
  // failed to match its own narration. The old fallback reused the previous
  // section's start, which is silently destructive: it gave that section zero
  // length and handed its whole span to the next one. In air-disasters that
  // left Vichai 1.3 seconds for 63 seconds of narration, so his story played
  // over the following story's photographs and nothing reported an error.
  //
  // The honest fallback uses what is known for certain: the narration IS the
  // sections joined in order, so a section's first word sits at a known index
  // in the stream, and that index carries a timestamp.
  const wordOffsets = [];
  let running = 0;
  for (const section of doc.sections) {
    wordOffsets.push(running);
    running += section.text.trim().split(/\s+/).filter(Boolean).length;
  }

  const starts = doc.sections.map((s, i) => {
    const cued = cueTime(narration.words, s.cueText || s.text);
    if (cued != null) return cued;
    if (i === 0) return 0;

    const idx = Math.min(wordOffsets[i], narration.words.length - 1);
    const estimated = narration.words[idx]?.start ?? 0;
    logger.warn(`could not cue section "${s.id}" — placing it at word ${idx} (${estimated.toFixed(1)}s) instead`);
    return estimated;
  });

  // A cue can also match in the wrong place and land out of order, which would
  // make a section run backwards. Keep the sequence monotonic either way.
  for (let i = 1; i < starts.length; i++) {
    if (starts[i] < starts[i - 1]) {
      logger.warn(`section "${doc.sections[i].id}" cued before the one before it — nudging it later`);
      starts[i] = starts[i - 1];
    }
  }
  const bounds = starts.map((s, i) => ({ start: s, end: i < starts.length - 1 ? starts[i + 1] : totalDuration }));

  const segmentPaths = [];
  for (let i = 0; i < doc.sections.length; i++) {
    const section = doc.sections[i];
    const { start, end } = bounds[i];
    const duration = Math.max(1, end - start);
    const images = section.images || [];
    if (!images.length) throw new Error(`section "${section.id}" has no images`);
    const perImage = duration / images.length;
    for (let j = 0; j < images.length; j++) {
      const imgPath = path.join(imgDir, images[j]);
      const segPath = path.join(dirs.segments, `${String(i).padStart(2, '0')}_${j}.mp4`);

      // A segment left behind by a killed run is usually truncated mid-write,
      // so size alone cannot clear it — the stamp is written only after ffmpeg
      // returns, and only a stamp matching this run's duration is trusted.
      const stampPath = `${segPath}.done`;
      const stamp = fresh ? null : await fsp.readFile(stampPath, 'utf8').catch(() => null);
      if (stamp && Math.abs(Number(stamp) - perImage) < 0.05) {
        segmentPaths.push(segPath);
        logger.info(`[${i + 1}/${doc.sections.length}] ${section.id} part ${j + 1}/${images.length}: kept from an earlier run`);
        continue;
      }

      await buildImageClip(imgPath, perImage, segPath, segmentPaths.length);
      await fsp.writeFile(stampPath, String(perImage));
      segmentPaths.push(segPath);
      logger.info(`[${i + 1}/${doc.sections.length}] ${section.id} part ${j + 1}/${images.length}: ${perImage.toFixed(1)}s`);
    }
  }

  const listPath = path.join(dirs.segments, 'list.txt');
  await fsp.writeFile(listPath, segmentPaths.map(p => `file '${path.resolve(p).replace(/\\/g, '/')}'`).join('\n'));
  const silentVideoPath = path.join(dirs.segments, 'concat.mp4');
  await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', silentVideoPath]);

  const finalPath = path.join(dirs.video, `${jobId}_documentary.mp4`);
  await runFFmpeg([
    '-y', '-i', silentVideoPath, '-i', audioPath,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest',
    '-movflags', '+faststart',
    finalPath
  ]);

  const srtPath = path.join(dirs.captions, `${jobId}_documentary.srt`);
  await fsp.writeFile(srtPath, buildSrt(narration.words));

  const stat = await fsp.stat(finalPath);
  logger.success(`${jobId}: documentary rendered (${Math.round(stat.size / 1048576)} MB, ${(totalDuration / 60).toFixed(1)} min) -> ${finalPath}`);
  logger.info(`Captions: ${srtPath}`);
}

main().catch(error => {
  logger.error(`produce-longform failed: ${error.message}`);
  process.exit(1);
});
