#!/usr/bin/env node
/**
 * Upload vertical shorts to YouTube.
 *
 *   node scripts/upload-shorts.js --dry-run        # show what would upload
 *   node scripts/upload-shorts.js                  # upload everything not yet up (private)
 *   node scripts/upload-shorts.js --limit 6        # respect the daily quota
 *   node scripts/upload-shorts.js --publish narco heysel munich
 *
 * QUOTA is the binding constraint here, not bandwidth. The Data API allows
 * 10,000 units a day and videos.insert costs 1,600, so SIX uploads a day is a
 * hard ceiling — the seventh fails outright. A privacy change (videos.update)
 * costs only 50, which is why publishing is a separate, cheap step rather than
 * part of the upload.
 *
 * Every upload is private and carries no publishAt. On YouTube, privacyStatus
 * 'private' PLUS publishAt does not mean private — it means "public at that
 * timestamp", which for an unreviewed video is the one behaviour to avoid.
 */

require('dotenv').config();

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { google } = require('googleapis');
const { Logger } = require('../../utils/logger');
const { addSubtitlesForJob, DEFAULT_LANGS } = require('../production/add-subtitles');
const { recordCurrentChannel } = require('../../utils/whop-os');

const ROOT = path.join(__dirname, '..', '..');
// DATA_ROOT/YT_TOKENS_FILE let a second channel (different data tree + OAuth
// token) reuse this exact script unchanged, e.g. DATA_ROOT=data/aftercache
// YT_TOKENS_FILE=tokens.aftercache.json node scripts/upload-shorts.js
const DATA_ROOT = process.env.DATA_ROOT || 'data';
const YT_TOKENS_FILE = process.env.YT_TOKENS_FILE || 'tokens.json';
const VIDEO_DIR = path.join(ROOT, DATA_ROOT, 'shorts', 'video');
const COPY_DIR = path.join(ROOT, DATA_ROOT, 'shorts', 'copy');
const LEDGER_PATH = path.join(ROOT, DATA_ROOT, 'shorts', 'uploads.json');
const QUEUE_PATH = process.env.QUEUE_PATH || path.join(ROOT, DATA_ROOT, 'queue.json');

const UPLOAD_COST = 1600;
// captions.insert costs 400 units, and every fresh short now gets subtitle
// tracks in DEFAULT_LANGS right after upload — folded into the per-short
// cost so the daily budget below doesn't silently blow through quota the
// way the one-off backfill did.
const CAPTIONS_COST = 400 * DEFAULT_LANGS.length;
const DAILY_QUOTA = 10000;

const logger = new Logger('UploadShorts');

function authorize() {
  const creds = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'credentials.json'), 'utf8')).youtube;
  const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', YT_TOKENS_FILE), 'utf8')).youtube;
  const oauth = new google.auth.OAuth2(creds.client_id, creds.client_secret, (creds.redirect_uris || [])[0]);
  oauth.setCredentials(tokens);
  return google.youtube({ version: 'v3', auth: oauth });
}

async function readLedger() {
  try {
    return JSON.parse(await fsp.readFile(LEDGER_PATH, 'utf8'));
  } catch (error) {
    return {};
  }
}


/**
 * Write ONE entry, merging against whatever is on disk right now.
 *
 * The previous code wrote back the whole ledger object it had read at startup.
 * Any change made in between — a publish from another run, a reconciliation —
 * was silently erased by the next upload. That happened for real: eight clips
 * were public on YouTube while this file still called them private, so the
 * dashboard and the "already uploaded" check were both working from fiction.
 * Re-reading immediately before the write keeps the file the source of truth
 * rather than a stale in-memory copy of it.
 */
async function saveEntry(id, entry) {
  const onDisk = await readLedger();
  onDisk[id] = { ...(onDisk[id] || {}), ...entry };
  await fsp.writeFile(LEDGER_PATH, JSON.stringify(onDisk, null, 2));
  return onDisk;
}

/**
 * The short's own hook makes the best title — it is the line already written to
 * stop a thumb inside a second, which is exactly a Shorts title's job.
 */
function buildMetadata(copy, job) {
  // Truncate the HOOK, not the finished title. Slicing after the suffix is
  // appended cut "#Shorts" clean off any hook near the limit — losing the tag
  // on exactly the videos whose titles were already working hardest.
  const SUFFIX = ' #Shorts';
  const room = 100 - SUFFIX.length;

  // Story shorts carry a title written for the feed ("... 😭🔥"), which has no
  // sentence punctuation to split on, so it travels on the queue entry instead.
  let hook = job.shortTitle || String(copy).split(/(?<=[.!?])\s+/)[0] || job.topic;
  hook = hook.replace(/\s+/g, ' ').trim();
  if (hook.length > room) {
    // Cut back to a word boundary so a title never ends mid-word.
    hook = `${hook.slice(0, room - 1).replace(/\s+\S*$/, '')}…`;
  }
  const title = hook + SUFFIX;

  const description = [
    String(copy).replace(/\s+/g, ' ').trim(),
    '',
    `Subject: ${job.topic}`,
    '',
    'Facts, dates and names come from public sources and are checked before publication.',
    '',
    (job.keywords || []).map(k => `#${String(k).replace(/[^a-z0-9]/gi, '')}`).join(' ')
  ].join('\n').slice(0, 5000);

  return {
    snippet: {
      title,
      description,
      tags: (job.keywords || []).slice(0, 15),
      categoryId: job.categoryId || '17',                 // default: Sports (Football Files)
      defaultLanguage: process.env.CONTENT_LANGUAGE || 'en',
      defaultAudioLanguage: process.env.CONTENT_LANGUAGE || 'en'
    },
    status: {
      privacyStatus: 'private',                           // never publishAt — see header
      selfDeclaredMadeForKids: false
    }
  };
}

async function publish(youtube, ids, ledger, dryRun) {
  for (const jobId of ids) {
    const entry = ledger[jobId];
    if (!entry) {
      logger.warn(`${jobId}: not uploaded yet — skipping`);
      continue;
    }
    if (entry.privacyStatus === 'public') {
      logger.info(`${jobId}: already public — ${entry.url}`);
      continue;
    }
    if (dryRun) {
      logger.info(`[dry-run] would publish ${jobId} -> ${entry.url}`);
      continue;
    }

    await youtube.videos.update({
      part: 'status',
      requestBody: {
        id: entry.videoId,
        status: { privacyStatus: 'public', selfDeclaredMadeForKids: false }
      }
    });
    entry.privacyStatus = 'public';
    entry.publishedAt = new Date().toISOString();
    await saveEntry(jobId, { privacyStatus: 'public', publishedAt: entry.publishedAt });
    logger.success(`${jobId} is PUBLIC -> ${entry.url}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 6;

  const ledger = await readLedger();
  const queue = JSON.parse(await fsp.readFile(QUEUE_PATH, 'utf8'));
  const youtube = dryRun ? null : authorize();

  if (args.includes('--publish')) {
    const ids = args.slice(args.indexOf('--publish') + 1).filter(a => !a.startsWith('--'));
    if (!ids.length) throw new Error('--publish needs at least one job id');
    await publish(youtube, ids, ledger, dryRun);
    return;
  }

  const files = (await fsp.readdir(VIDEO_DIR)).filter(f => f.endsWith('_short.mp4'));
  const pending = files.map(f => f.replace('_short.mp4', '')).filter(id => !ledger[id]);

  if (!pending.length) {
    logger.info(`Nothing new — ${Object.keys(ledger).length} short(s) already on the channel.`);
    return;
  }

  // --no-subs doubles the daily ceiling from 3 uploads to 6. The subtitle
  // tracks cost as much as the video itself (1,600 units for four languages
  // against 1,600 for the upload), and captions are already burned into the
  // frame — what is skipped is only YouTube's selectable CC track.
  const noSubs = args.includes('--no-subs');
  const perShort = UPLOAD_COST + (noSubs ? 0 : CAPTIONS_COST);
  const budget = Math.min(limit, Math.floor(DAILY_QUOTA / perShort));
  const batch = pending.slice(0, budget);

  logger.info(`${pending.length} not yet uploaded; doing ${batch.length} this run `
    + `(${batch.length * perShort} of ${DAILY_QUOTA} quota units${noSubs ? ', no subtitle tracks' : ', incl. subtitles'})`);
  if (pending.length > batch.length) {
    logger.warn(`${pending.length - batch.length} left for tomorrow — the daily quota allows only ${budget}`);
  }

  for (const jobId of batch) {
    const job = queue.topics.find(j => j.id === jobId) || { topic: jobId, keywords: [] };
    const videoPath = path.join(VIDEO_DIR, `${jobId}_short.mp4`);
    const copy = await fsp.readFile(path.join(COPY_DIR, `${jobId}_short.txt`), 'utf8').catch(() => job.topic);
    const metadata = buildMetadata(copy, job);
    const sizeMb = Math.round((await fsp.stat(videoPath)).size / 1048576);

    if (dryRun) {
      logger.info(`[dry-run] ${jobId} (${sizeMb} MB) — "${metadata.snippet.title}"`);
      continue;
    }

    try {
      logger.info(`Uploading ${jobId} (${sizeMb} MB)...`);
      const res = await youtube.videos.insert({
        part: 'snippet,status',
        requestBody: metadata,
        media: { body: fs.createReadStream(videoPath) }
      });

      ledger[jobId] = {
        videoId: res.data.id,
        url: `https://www.youtube.com/watch?v=${res.data.id}`,
        privacyStatus: res.data.status?.privacyStatus || 'private',
        title: metadata.snippet.title,
        uploadedAt: new Date().toISOString()
      };
      await saveEntry(jobId, ledger[jobId]);
      logger.success(`${jobId} -> ${ledger[jobId].url} (private)`);

      // Only ever runs on a short THIS invocation just uploaded — never a
      // backfill pass over the existing library.
      try {
        if (noSubs) throw new Error('skipped by --no-subs');
        await addSubtitlesForJob(jobId, DEFAULT_LANGS, youtube);
      } catch (subError) {
        logger.warn(`${jobId}: subtitle tracks failed (${String(subError.message).slice(0, 100)}) — video upload itself still succeeded`);
      }
    } catch (error) {
      const msg = String(error.message);
      logger.error(`${jobId} failed: ${msg.slice(0, 140)}`);
      if (/quota/i.test(msg)) {
        logger.error('Daily quota exhausted — stopping. Resume tomorrow.');
        break;
      }
    }
  }

  logger.info(`${Object.keys(ledger).length} short(s) on the channel. `
    + 'Publish with: node scripts/upload-shorts.js --publish <ids>');

  // Record where the channel stands now, so the WHOP OS dashboard's history is
  // a record of what the channel did rather than of when someone last opened it
  // and pressed refresh. Never throws — see utils/whop-os.js.
  if (youtube) await recordCurrentChannel(youtube);
}

// Guarded, because without this ANY require() of this file uploads videos.
// A syntax check that imported this module ran the
// uploader with no arguments: no --dry-run, no DATA_ROOT, so a Kai Cenat
// top-5 went to Football Files on the default token. Importing a module must
// never publish anything.
if (require.main === module) {
  main().catch(error => {
    logger.error(`upload-shorts failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { main };
