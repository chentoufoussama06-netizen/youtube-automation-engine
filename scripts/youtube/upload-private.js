#!/usr/bin/env node
/**
 * Upload finished renders to YouTube as PRIVATE, one at a time.
 *
 * The pipeline's own publishing-scheduling-agent sets `status.publishAt`
 * alongside privacyStatus:'private'. On YouTube that pair does not mean
 * "private" — it means "private until this timestamp, then public
 * automatically". For a first upload that nobody has watched yet, that is the
 * one behaviour you do not want, so this script never sends publishAt at all.
 * A video uploaded here stays private until a human changes it in Studio.
 *
 *   node scripts/upload-private.js --dry-run        # show what would upload
 *   node scripts/upload-private.js                  # upload every done job
 *   node scripts/upload-private.js sala escobar     # upload specific job ids
 *   node scripts/upload-private.js --compilation pitch-deaths --dry-run
 *   node scripts/upload-private.js --compilation pitch-deaths --public
 */

require('dotenv').config();

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { google } = require('googleapis');
const { Logger } = require('../../utils/logger');
const { recordCurrentChannel } = require('../../utils/whop-os');

const ROOT = path.join(__dirname, '..', '..');
// DATA_ROOT / YT_TOKENS_FILE pick the channel, the same way upload-shorts.js
// does, so the autopilot can post AFTER CACHE's compilations to AFTER CACHE.
const DATA_ROOT = process.env.DATA_ROOT || 'data';
const YT_TOKENS_FILE = process.env.YT_TOKENS_FILE || 'tokens.json';
const QUEUE_PATH = process.env.QUEUE_PATH || path.join(ROOT, DATA_ROOT, 'queue.json');
const logger = new Logger('UploadPrivate');

function authorize() {
  const creds = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'credentials.json'), 'utf8')).youtube;
  const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', YT_TOKENS_FILE), 'utf8')).youtube;
  const oauth = new google.auth.OAuth2(creds.client_id, creds.client_secret, (creds.redirect_uris || [])[0]);
  oauth.setCredentials(tokens);
  return google.youtube({ version: 'v3', auth: oauth });
}

// Long-form documentary narration. Keep the description factual — this
// channel's whole premise is that the dates and names are real.
//
// The channel moved from French to a worldwide English audience on 2026-08-29,
// so this copy is English and the language fields follow CONTENT_LANGUAGE.
// Anything already uploaded keeps the language it was published with.
/**
 * Credits for the Commons stills, and the articles the narration was built on.
 *
 * This is not politeness. The images are used under CC BY and CC BY-SA, whose
 * one condition is attribution, so publishing them uncredited turns a correctly
 * licensed video into an infringing one. utils/archival-images.js already
 * refuses anything non-commercial or no-derivatives; crediting here is the last
 * step that keeps the set legal.
 */
function buildCredits(job) {
  const lines = [];

  const sources = job.sources || [];
  if (sources.length) {
    lines.push('', 'Sources');
    for (const s of sources) lines.push(`• ${s.article} — ${s.url}`);
  }

  const credits = job.attribution || [];
  if (credits.length) {
    // One file can be pulled for more than one section; credit it once.
    const seen = new Set();
    lines.push('', 'Images (Wikimedia Commons)');
    for (const c of credits) {
      if (seen.has(c.file)) continue;
      seen.add(c.file);
      lines.push(`• ${c.file} — ${c.author}, ${c.license}`);
    }
  }

  return lines;
}

function buildMetadata(job, { makePublic = false } = {}) {
  const title = (job.title || job.topic || 'Documentary').slice(0, 100);
  const description = [
    job.angle || '',
    '',
    job.topic ? `Subject: ${job.topic}` : '',
    '',
    'The facts, dates and names in this documentary come from public sources',
    'and are checked before publication.',
    ...buildCredits(job)
  ].filter((line, i, all) => !(line === '' && all[i - 1] === '')).join('\n').slice(0, 5000);

  return {
    snippet: {
      title,
      description,
      tags: (job.keywords || []).slice(0, 15),
      categoryId: process.env.CATEGORY_ID || '17',   // default: Sports
      defaultLanguage: process.env.CONTENT_LANGUAGE || 'en',
      defaultAudioLanguage: process.env.CONTENT_LANGUAGE || 'en'
    },
    status: {
      // Still no publishAt, even with --public. See the header comment:
      // publishAt means "go public later, on a timer", which is a different
      // thing from going public now and is not what either flag asks for.
      privacyStatus: makePublic ? 'public' : 'private',
      selfDeclaredMadeForKids: false
    }
  };
}

/**
 * A compilation is not a queue topic — build-compilation.js assembles it from
 * several of them — so it has no entry in queue.json for the candidate scan to
 * find. This turns one into the shape uploadOne already expects.
 */
async function compilationJob(id) {
  const docPath = path.join(ROOT, DATA_ROOT, 'scripts', `longform_${id}.json`);
  const doc = JSON.parse(await fsp.readFile(docPath, 'utf8'));
  const videoPath = path.join(ROOT, DATA_ROOT, 'videos', `${id}_documentary.mp4`);
  await fsp.stat(videoPath);   // throws a clear ENOENT if it was never rendered

  // Credits come from the sidecars the downloader wrote next to each image,
  // not from the script's copy of them. The sidecar is authoritative: it is
  // written at download time straight from the Commons metadata, whereas the
  // script's copy has already been wrong once — it read a field named `author`
  // that does not exist, and credited every CC BY image to "unknown".
  const imgDir = path.join(ROOT, DATA_ROOT, 'reference', `${id}-archival`);
  const used = new Set(doc.sections.flatMap((s) => s.images || []));
  const attribution = [];
  for (const file of used) {
    const sidecar = await fsp.readFile(path.join(imgDir, `${file}.json`), 'utf8')
      .then(JSON.parse).catch(() => null);
    if (!sidecar) {
      logger.warn(`No credit sidecar for ${file} — it will be credited as unknown.`);
      attribution.push({ file, author: 'unknown', license: 'unknown' });
      continue;
    }
    attribution.push({
      file: sidecar.title || file,
      author: sidecar.artist || sidecar.credit || 'unknown',
      license: sidecar.license || 'unknown',
      source: sidecar.descriptionUrl
    });
  }

  const unknown = attribution.filter((a) => a.author === 'unknown').length;
  if (unknown) logger.warn(`${unknown} image(s) have no named creator; CC BY requires one.`);

  return {
    id,
    title: doc.title,
    angle: doc.angle,
    keywords: doc.keywords,
    attribution,
    sources: doc.sources,
    videoPath,
    isCompilation: true
  };
}

async function uploadOne(youtube, job, dryRun, { makePublic = false } = {}) {
  const videoPath = job.videoPath;
  if (!videoPath) throw new Error('job has no videoPath');

  const stat = await fsp.stat(videoPath);
  if (!stat.isFile() || path.extname(videoPath).toLowerCase() !== '.mp4') {
    throw new Error(`not an mp4: ${videoPath}`);
  }

  const metadata = buildMetadata(job, { makePublic });
  const sizeMb = Math.round(stat.size / 1024 / 1024);

  if (dryRun) {
    logger.info(`[dry-run] ${job.id}: "${metadata.snippet.title}" (${sizeMb} MB, privacy=${metadata.status.privacyStatus})`);
    console.log('\n--- description that would be sent ---');
    console.log(metadata.snippet.description);
    console.log(`--- tags: ${(metadata.snippet.tags || []).join(', ')}\n`);
    return null;
  }

  logger.info(`Uploading ${job.id} (${sizeMb} MB) as ${metadata.status.privacyStatus}...`);
  const res = await youtube.videos.insert({
    part: 'snippet,status',
    requestBody: metadata,
    media: { body: fs.createReadStream(videoPath) }
  });

  const id = res.data.id;
  const url = `https://www.youtube.com/watch?v=${id}`;
  logger.success(`${job.id} -> ${url} (${res.data.status?.privacyStatus})`);
  return { id, url, privacyStatus: res.data.status?.privacyStatus };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const makePublic = args.includes('--public');
  const compilations = args.includes('--compilation');
  const ids = args.filter(a => !a.startsWith('--'));

  const queue = JSON.parse(await fsp.readFile(QUEUE_PATH, 'utf8'));
  let candidates;

  if (compilations) {
    if (!ids.length) throw new Error('name the compilation(s): --compilation pitch-deaths');
    candidates = await Promise.all(ids.map(compilationJob));
  } else {
    candidates = queue.topics.filter(j =>
      j.status === 'done' && j.videoPath && (!ids.length || ids.includes(j.id))
    );
  }

  if (!candidates.length) {
    logger.warn('No finished jobs with a videoPath to upload.');
    return;
  }

  const youtube = dryRun ? null : authorize();
  const results = [];

  for (const job of candidates) {
    try {
      const out = await uploadOne(youtube, job, dryRun, { makePublic });
      if (out) {
        // A compilation has no queue entry to write back to; its record is the
        // script it was built from plus this log line.
        if (!job.isCompilation) {
          job.youtubeId = out.id;
          job.youtubeUrl = out.url;
          job.uploadedAt = new Date().toISOString();
          await fsp.writeFile(QUEUE_PATH, JSON.stringify(queue, null, 2));
        }
        results.push(out);
      }
    } catch (error) {
      logger.error(`${job.id} failed: ${error.message}`);
    }
  }

  if (results.length) {
    logger.success(`Uploaded ${results.length} video(s) as ${makePublic ? 'PUBLIC' : 'private'}:`);
    for (const r of results) logger.info(`  ${r.url}`);
    if (!makePublic) logger.info('They stay private until you change it in YouTube Studio.');
  }

  // Same reason as upload-shorts.js: the dashboard should learn the channel's
  // numbers from what was published, not from when someone last looked.
  if (youtube) {
    await recordCurrentChannel(youtube);
  }
}

main().catch(error => {
  logger.error(`Upload run failed: ${error.message}`);
  process.exit(1);
});
