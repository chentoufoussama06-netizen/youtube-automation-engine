#!/usr/bin/env node
/**
 * Cut a vertical short out of a finished episode.
 *
 *   node scripts/make-short.js escobar                 # split-screen (default)
 *   node scripts/make-short.js escobar --layout full   # story fills the frame
 *   node scripts/make-short.js escobar --script-only    # write the copy, render nothing
 *
 * A short reuses the episode's research and its cast voice, so the channel
 * sounds like one body of work rather than a long video plus some clips. The
 * expensive part — writing and checking the story — is already paid for.
 */

require('dotenv').config();

const fsp = require('fs').promises;
const path = require('path');
const { ShortsFactory, MOTION_QUERIES } = require('../../utils/shorts-factory');
const { AIVideoGenerator } = require('../../utils/ai-video-generator');
const { Logger } = require('../../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const QUEUE_PATH = process.env.QUEUE_PATH || path.join(ROOT, 'data', 'queue.json');
const SHORTS_DIR = path.join(ROOT, 'data', 'shorts');
const SCRIPTS_DIR = path.join(ROOT, 'data', 'scripts');

// Every short produces four files. Flat, that is 40 files for ten shorts and
// the .mp4s — the only ones you actually open or upload — are buried among the
// working files. One folder per kind keeps the deliverables together.
const OUT = {
  video: path.join(SHORTS_DIR, 'video'),
  audio: path.join(SHORTS_DIR, 'audio'),
  captions: path.join(SHORTS_DIR, 'captions'),
  copy: path.join(SHORTS_DIR, 'copy')
};

const logger = new Logger('MakeShort');

/**
 * The script belonging to THIS job, or null.
 *
 * There is deliberately no "newest script" fallback. A job that has never been
 * rendered has no production id, and falling back to whatever was written last
 * would cut every short from one unrelated episode — ten shorts about Escobar
 * wearing ten different topics' names. Returning null is correct: the caller
 * writes a fresh script for the actual topic.
 */
async function findScript(job) {
  // The script this job last used, recorded on the job itself. Without this,
  // a topic that has never had a long render matches nothing and writes a fresh
  // script on EVERY run — 46 files accumulated from a handful of topics.
  if (job.scriptPath) {
    try {
      await fsp.access(job.scriptPath);
      return job.scriptPath;
    } catch (error) { /* recorded but since deleted — fall through */ }
  }

  if (!job.productionId) return null;

  const files = (await fsp.readdir(SCRIPTS_DIR)).filter(f => f.endsWith('_script.json'));
  const stamp = job.productionId.split('_')[1];
  const match = files.find(f => f.startsWith(stamp));
  return match ? path.join(SCRIPTS_DIR, match) : null;
}

/**
 * The longest video sitting in data/gameplay/, if any.
 *
 * Longest wins because the offset ledger draws non-overlapping windows from it:
 * a two-hour capture yields roughly 160 distinct 45-second clips before it has
 * to repeat, where a five-minute one repeats almost immediately.
 */
async function findGameplaySource() {
  const dir = path.join(ROOT, 'data', 'gameplay');
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch (error) {
    return null;                       // folder not created yet
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
  const args = process.argv.slice(2);
  const jobId = args.find(a => !a.startsWith('--'));
  const scriptOnly = args.includes('--script-only');
  const layout = args.includes('--layout') ? args[args.indexOf('--layout') + 1] : 'split';

  if (!jobId) {
    throw new Error('usage: node scripts/make-short.js <jobId> [--layout full] [--script-only]');
  }

  const queue = JSON.parse(await fsp.readFile(QUEUE_PATH, 'utf8'));
  const job = queue.topics.find(j => j.id === jobId);
  if (!job) throw new Error(`no job "${jobId}" in the queue`);

  // --reuse recomposites the video from narration and captions that already
  // exist, changing nothing about the writing. It is what you want after a
  // rendering improvement: regenerating would also rewrite the copy, and a
  // short whose script you already approved would come back saying something
  // different. Only the picture changes.
  if (args.includes('--reuse')) {
    const audioPath = path.join(OUT.audio, `${jobId}_short.mp3`);
    const captionPath = path.join(OUT.captions, `${jobId}_short.ass`);
    for (const required of [audioPath, captionPath]) {
      try {
        await fsp.access(required);
      } catch (error) {
        throw new Error(`--reuse needs ${path.basename(required)}; render it normally first`);
      }
    }

    const factory = new ShortsFactory({});
    const generator = new AIVideoGenerator({});
    const seconds = await factory.probeDuration(audioPath);
    const copyPath = path.join(OUT.copy, `${jobId}_short.txt`);
    const existingCopy = await fsp.readFile(copyPath, 'utf8').catch(() => '');

    const wanted = Math.max(3, Math.min(6, Math.round(seconds / 8)));
    const picks = existingCopy
      ? await factory.visualQueriesForShort(existingCopy, wanted, {})
      : [];

    const storyClips = [];
    for (const query of picks) {
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
    const source = args.includes('--gameplay') ? args[args.indexOf('--gameplay') + 1] : await findGameplaySource();
    if (source) {
      try {
        motionStart = await factory.pickGameplayWindow(source, seconds);
        motionClip = source;
      } catch (error) {
        logger.warn(`gameplay unusable (${String(error.message).slice(0, 60)})`);
      }
    }

    const outputPath = path.join(OUT.video, `${jobId}_short.mp4`);
    await factory.renderShort({
      storyClips, motionClip, motionStart, audioPath, captionPath, outputPath,
      layout: motionClip ? layout : 'full'
    });
    const stat = await fsp.stat(outputPath);
    logger.success(`${jobId}: recomposited (${Math.round(stat.size / 1048576)} MB, ${seconds.toFixed(0)}s) — copy unchanged`);
    return;
  }

  // A short needs a researched script, but NOT the 25-minute long render that
  // normally produces one. Writing the script alone takes about 90 seconds, so
  // a topic with no episode yet is not a blocker — and it is saved in the usual
  // place, so a later long render reuses this research instead of redoing it.
  const forceNewScript = args.includes('--new-script');
  let scriptPath = forceNewScript ? null : await findScript(job);
  let script;

  if (scriptPath) {
    script = JSON.parse(await fsp.readFile(scriptPath, 'utf8'));
    logger.info(`Source: ${path.basename(scriptPath)} — "${script.title}"`);
  } else {
    logger.info(`No script for "${jobId}" yet — writing one (~90s)`);
    const { ScriptWriterAgent } = require('../../agents/script-writer-agent');
    const { Database } = require('../../database/db');
    const { CredentialManager } = require('../../utils/credential-manager');

    const db = new Database();
    await db.initialize();
    const credentials = new CredentialManager();
    if (typeof credentials.initialize === 'function') await credentials.initialize();

    const writer = new ScriptWriterAgent(db, credentials);
    script = await writer.generateScript({
      topic: job.topic,
      contentType: job.contentType || 'Story',
      angle: job.angle,
      targetAudience: process.env.TARGET_AUDIENCE,
      keywords: job.keywords || []
    });

    // Retire the version this replaces before writing the new one, and record
    // the path on the job so the next run finds it instead of writing another.
    if (job.scriptPath) {
      await fsp.unlink(job.scriptPath).catch(() => {});
      logger.info(`Removed superseded script ${path.basename(job.scriptPath)}`);
    }

    await fsp.mkdir(SCRIPTS_DIR, { recursive: true });
    scriptPath = path.join(SCRIPTS_DIR, `${Date.now()}_script.json`);
    await fsp.writeFile(scriptPath, JSON.stringify(script, null, 2));

    job.scriptPath = scriptPath;
    await fsp.writeFile(QUEUE_PATH, JSON.stringify(queue, null, 2));

    logger.info(`Script written: "${script.title}" (${script.mainContent?.sections?.length || 0} sections)`);
  }

  for (const dir of Object.values(OUT)) {
    await fsp.mkdir(dir, { recursive: true });
  }
  const factory = new ShortsFactory({});

  // 1. The copy.
  const short = await factory.writeShortScript(script);
  console.log(`\n--- HOOK ---\n${short.hook}\n\n--- DRAFT (${short.wordCount} words) ---\n${short.fullText}\n`);

  // 2. Verify BEFORE narrating. Checking after the render would mean throwing
  //    away the audio, the captions and the encode every time a claim is wrong.
  let finalText = short.fullText;
  if (!args.includes('--skip-factcheck')) {
    const check = await factory.factCheckShort(short.fullText, script);
    if (check.changed) {
      finalText = check.corrected;
      console.log(`--- CORRECTED ---\n${finalText}\n`);
    }
    if (check.failed) {
      logger.warn('Copy is UNVERIFIED — read it yourself before publishing');
    }
  } else {
    logger.warn('Fact-check skipped (--skip-factcheck)');
  }

  await fsp.writeFile(path.join(OUT.copy, `${jobId}_short.txt`), finalText);

  if (scriptOnly) {
    logger.info('Copy written. Nothing rendered (--script-only).');
    return;
  }

  // 2. Narration in the episode's own cast voice, with real word timings.
  const voice = job.voice || process.env.EDGE_TTS_VOICE || 'en-GB-RyanNeural';
  const audioPath = path.join(OUT.audio, `${jobId}_short.mp3`);
  const narration = await factory.narrateWithTiming(finalText, voice, audioPath);
  const seconds = await factory.probeDuration(audioPath);
  logger.info(`Narration: ${seconds.toFixed(1)}s in ${voice}`);
  if (seconds > 60) {
    logger.warn(`${seconds.toFixed(0)}s exceeds the 60s Shorts limit — shorten the copy and re-run`);
  }

  // 3. Captions.
  const captionPath = path.join(OUT.captions, `${jobId}_short.ass`);
  await fsp.writeFile(captionPath, factory.buildCaptions(narration.words));

  // 4. Footage. Portrait story clips come from the same Pexels library the
  //    long-form uses, so repeated queries cost no new downloads.
  // Queries come from the SHORT's own beats, not the long script's opening
  // sections — see visualQueriesForShort. Using section queries here meant the
  // pictures followed chapters 1-5 of a 14-chapter documentary while the
  // narration told the whole story.
  const generator = new AIVideoGenerator({});
  const wanted = Math.max(3, Math.min(6, Math.round(seconds / 8)));
  const picks = await factory.visualQueriesForShort(finalText, wanted, script);

  const storyClips = [];
  for (const query of picks) {
    try {
      const clip = await generator.fetchPexelsClipCached(query, 'portrait');
      if (clip) storyClips.push(clip);
    } catch (error) {
      logger.warn(`story clip "${query}" failed: ${String(error.message).slice(0, 60)}`);
    }
  }
  if (!storyClips.length) throw new Error('no story clips could be sourced');

  // Real, rights-cleared stills (Wikimedia Commons — see utils/archival-images.js)
  // bookend the generic Pexels beats rather than replacing them wholesale: the
  // middle of the story still needs SOMETHING on screen, and stock is the only
  // footage that can legally depict a scene nobody photographed. Swapped into
  // the array in place (same length) so renderShort()'s segment math is
  // untouched — only which clip plays in each slot changes.
  if (job.realImages?.length && storyClips.length) {
    const realDir = path.join(SHORTS_DIR, 'real-clips');
    await fsp.mkdir(realDir, { recursive: true });
    const segmentSeconds = Math.max(3, seconds / storyClips.length);
    for (let i = 0; i < job.realImages.length && i < storyClips.length; i++) {
      const slot = storyClips.length - 1 - i;             // fill from the end
      const clipPath = path.join(realDir, `${jobId}_real${i}.mp4`);
      try {
        await factory.stillToClip(job.realImages[i], segmentSeconds + 1, clipPath);
        storyClips[slot] = clipPath;
        logger.info(`Real image slotted in at beat ${slot + 1}/${storyClips.length}: ${path.basename(job.realImages[i])}`);
      } catch (error) {
        logger.warn(`real image "${job.realImages[i]}" failed: ${String(error.message).slice(0, 60)}`);
      }
    }
  }

  // Bottom panel. A long local capture (gameplay, driving, anything with
  // continuous motion) is preferred over stock: it is unlimited, it belongs to
  // this channel alone, and one two-hour file is months of material. Stock is
  // the fallback so a missing capture never blocks a render.
  let motionClip = null;
  let motionStart = 0;
  if (layout === 'split') {
    const explicit = args.includes('--gameplay') ? args[args.indexOf('--gameplay') + 1] : null;
    const source = explicit || await findGameplaySource();

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
  }

  // 5. Compose.
  const outputPath = path.join(OUT.video, `${jobId}_short.mp4`);
  await factory.renderShort({
    storyClips, motionClip, motionStart, audioPath, captionPath, outputPath,
    layout: motionClip ? layout : 'full'
  });

  const stat = await fsp.stat(outputPath);
  logger.success(`${outputPath} (${Math.round(stat.size / 1024 / 1024)} MB, ${seconds.toFixed(0)}s)`);
}

main().catch(error => {
  logger.error(`make-short failed: ${error.message}`);
  process.exit(1);
});
