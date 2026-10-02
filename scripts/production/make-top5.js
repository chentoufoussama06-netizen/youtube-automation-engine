#!/usr/bin/env node
/**
 * Stitch already-produced clips into one "Top N" countdown short: an intro
 * card, then each pick counted down from N to 1 with its own number/hook
 * title card, cut straight into that clip's own already-rendered, already-
 * captioned video. No new source VOD, no new download, no new transcription
 * — this only recombines work the clip pipeline (make-clip.js/find-clips.js)
 * already paid for, which is what keeps it cheap on both API quota and the
 * memory this machine is short on.
 *
 *   node scripts/make-top5.js --id top5-kai-speed --count 5 \
 *     [--prefixes kaisu,speedmessi,kaibodycam,kaitota] [--theme "Kai Cenat & IShowSpeed"]
 */

require('dotenv').config();

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { google } = require('googleapis');
const { runFFmpeg } = require('../../utils/ffmpeg');
const { AITextService } = require('../../utils/ai-text-service');
const { Logger } = require('../../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const LEDGER_PATH = path.join(ROOT, 'data', 'shorts', 'uploads.json');
const VIDEO_DIR = path.join(ROOT, 'data', 'shorts', 'video');
const WORK_DIR = path.join(ROOT, 'data', 'clips', 'topfive');
const SFX_DIR = path.join(ROOT, 'data', 'audio', 'sfx');
const FONT = 'C:/Windows/Fonts/arialbd.ttf';

const logger = new Logger('MakeTopFive');

function authorize() {
  const creds = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'credentials.json'), 'utf8')).youtube;
  const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'tokens.json'), 'utf8')).youtube;
  const oauth = new google.auth.OAuth2(creds.client_id, creds.client_secret, (creds.redirect_uris || [])[0]);
  oauth.setCredentials(tokens);
  return google.youtube({ version: 'v3', auth: oauth });
}

/** Same drive-letter-colon problem as ShortsFactory._escapeForFilter / make-clip.js escapeForFilter. */
function escapeForFilter(filePath) {
  const relative = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
  if (relative && !relative.startsWith('..')) return relative;
  return filePath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');
}

/** ffmpeg drawtext has no auto line-wrap — break long hooks ourselves so they fit the 1080-wide card. */
function wrapText(text, maxChars = 22) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line && (line.length + 1 + word.length) > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

async function loadCandidates(prefixes) {
  const ledger = JSON.parse(await fsp.readFile(LEDGER_PATH, 'utf8'));
  return Object.entries(ledger)
    .filter(([id, v]) => v.source === 'clip' && prefixes.some(p => id.startsWith(p)))
    .map(([id, v]) => ({ id, title: v.title.replace(/\s*#Shorts\s*$/i, ''), videoPath: path.join(VIDEO_DIR, `${id}_short.mp4`) }))
    .filter(c => fs.existsSync(c.videoPath));
}

/**
 * Pick and order N of the candidates using their titles alone — that is all
 * the signal this ledger has (no view counts recorded). "rank" counts down
 * N..1 the way every countdown video is watched: least wild first, biggest
 * moment last.
 */
async function rankPicks(candidates, count, theme) {
  const service = new AITextService({});
  if (!service.isAvailable()) throw new Error('no AI text provider available for ranking');
  const list = candidates.map((c, i) => `${i}. ${c.title}`).join('\n');
  const prompt = `Pick the ${count} best entries for a "Top ${count} ${theme} Moments" countdown video, `
    + `from this list of already-made clips (titles only — pick on how wild/shareable the title sounds). `
    + `Rank them #${count} (least wild) through #1 (most wild, save the best for last) — classic countdown `
    + `order, biggest moment revealed last. Write a punchy on-screen "hook" line for each, under 8 words, `
    + `present tense — not just a repeat of the title.\n\n${list}\n\n`
    + `Return only valid JSON: {"picks": [{"index": 0, "rank": ${count}, "hook": "..."}, ...]} — exactly `
    + `${count} entries, "rank" values every integer from ${count} down to 1 with no repeats, "index" from `
    + 'the list above with no repeats.';
  const raw = await service.generateText(prompt, { maxTokens: 900, temperature: 0.6, json: true });
  const parsed = JSON.parse(String(raw).replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim().match(/\{[\s\S]*\}/)[0]);
  const picks = (parsed.picks || []).filter(p => candidates[p.index]);
  if (picks.length !== count) throw new Error(`ranking returned ${picks.length} usable picks, expected ${count}`);
  picks.sort((a, b) => b.rank - a.rank); // count down: highest rank number plays first
  return picks.map(p => ({ ...candidates[p.index], rank: p.rank, hook: p.hook }));
}

/**
 * Sound effects, kept in data/audio/sfx/.
 *
 * Drop real meme sounds in there as boom.mp3, whoosh.mp3 or pop.mp3 and they
 * get used. Nothing is fetched automatically: the well-known ones are lifted
 * from films, shows and songs whose owners run Content ID, and this channel has
 * already had one video disappear — a synthesised stand-in cannot cost a
 * strike. So when a file is missing it is generated here from oscillators and
 * noise, which reads as an impact and is owned by nobody.
 */
async function ensureSfx() {
  await fsp.mkdir(SFX_DIR, { recursive: true });

  const recipes = {
    // A low sine dropping in pitch and decaying fast — the hit on a cut.
    boom: ['-f', 'lavfi', '-i', 'sine=frequency=62:duration=0.7',
      '-af', 'asetrate=44100*0.7,aresample=44100,afade=t=out:st=0:d=0.7:curve=exp,volume=2.2'],
    // Filtered noise swelling then cut away — the transition whoosh.
    whoosh: ['-f', 'lavfi', '-i', 'anoisesrc=duration=0.45:color=pink',
      '-af', 'highpass=f=350,lowpass=f=5200,afade=t=in:st=0:d=0.18,afade=t=out:st=0.2:d=0.25,volume=1.6'],
    // A short click to land the number on screen.
    pop: ['-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.12',
      '-af', 'afade=t=out:st=0:d=0.12:curve=exp,volume=1.4']
  };

  const paths = {};
  for (const [name, args] of Object.entries(recipes)) {
    const supplied = ['mp3', 'wav', 'm4a']
      .map(ext => path.join(SFX_DIR, `${name}.${ext}`))
      .find(p => fs.existsSync(p));
    if (supplied) { paths[name] = supplied; continue; }

    const generated = path.join(SFX_DIR, `${name}.wav`);
    if (!fs.existsSync(generated)) {
      await runFFmpeg(['-y', ...args, '-c:a', 'pcm_s16le', generated]);
      logger.info(`generated a stand-in ${name} — drop your own ${name}.mp3 in ${SFX_DIR} to replace it`);
    }
    paths[name] = generated;
  }
  return paths;
}

/**
 * One pick: a trimmed slice of the clip, its rank burned over the footage, and
 * an impact on the cut.
 *
 * What this replaces put a two-second black card in front of every clip and
 * then played the clip whole, which ran the first attempt to 173 seconds.
 * Measured against the channels winning this format right now, the median Top 5
 * short is 61 seconds and not one of them stops the video dead to show text. So
 * the number goes ON the footage and nothing pauses.
 */
async function buildPick(pick, seconds, sfx, outPath) {
  const font = escapeForFilter(FONT);
  const rankFile = `${outPath}.rank.txt`;
  await fsp.writeFile(rankFile, `#${pick.rank}`);
  const hookFile = `${outPath}.hook.txt`;
  await fsp.writeFile(hookFile, wrapText(pick.hook));

  // The number lands for a beat then gets out of the way, with the hook under
  // it for the same time. Both fade rather than cut — a hard pop of text reads
  // as a glitch at this speed.
  const vf = [
    `drawtext=fontfile='${font}':textfile='${escapeForFilter(rankFile)}':fontcolor=white:`
      + 'fontsize=190:borderw=10:bordercolor=black:x=(w-text_w)/2:y=200:'
      + "enable='lt(t,2.2)':alpha='if(lt(t,1.8),1,(2.2-t)/0.4)'",
    `drawtext=fontfile='${font}':textfile='${escapeForFilter(hookFile)}':fontcolor=white:`
      + 'fontsize=58:borderw=6:bordercolor=black:line_spacing=12:x=(w-text_w)/2:y=430:'
      + "enable='lt(t,2.2)':alpha='if(lt(t,1.8),1,(2.2-t)/0.4)'"
  ].join(',');

  await runFFmpeg([
    '-y',
    '-t', String(seconds), '-i', pick.videoPath,
    '-i', sfx.boom,
    '-i', sfx.whoosh,
    '-filter_complex',
    `[0:v]${vf},fps=30,format=yuv420p[v];`
    // The clip keeps its own audio; the hit and the whoosh sit on top of the
    // first half second rather than replacing any of it.
    + '[1:a]volume=0.9[boom];'
    + '[2:a]volume=0.7[wh];'
    + '[0:a][boom][wh]amix=inputs=3:duration=first:dropout_transition=0:normalize=0,'
    + 'alimiter=limit=0.95[a]',
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
    outPath
  ]);
}

async function makeCard(mainText, subText, durationSec, outPath) {
  const mainFile = `${outPath}.main.txt`;
  await fsp.writeFile(mainFile, mainText);
  const font = escapeForFilter(FONT);

  let vf = `drawtext=fontfile='${font}':textfile='${escapeForFilter(mainFile)}':fontcolor=white:`
    + `fontsize=200:x=(w-text_w)/2:y=${subText ? 'h/2-280' : '(h-text_h)/2'}:line_spacing=10`;
  if (subText) {
    const subFile = `${outPath}.sub.txt`;
    await fsp.writeFile(subFile, wrapText(subText));
    vf += `,drawtext=fontfile='${font}':textfile='${escapeForFilter(subFile)}':fontcolor=white:`
      + "fontsize=64:x=(w-text_w)/2:y=h/2+20:line_spacing=14";
  }

  await runFFmpeg([
    '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=1080x1920:d=${durationSec}:r=30`,
    '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo:d=${durationSec}`,
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k',
    outPath
  ]);
}

async function concatSegments(segmentPaths, outPath) {
  const listPath = path.join(WORK_DIR, 'concat.txt');
  // concat demuxer paths resolve relative to the list file itself.
  const lines = segmentPaths.map(p => `file '${path.relative(WORK_DIR, p).replace(/\\/g, '/')}'`);
  await fsp.writeFile(listPath, lines.join('\n'));
  // Re-encoding on the way through (no -c copy) because the title cards and
  // the individual clips were never guaranteed to share exact encode
  // parameters — safe over fast, same tradeoff make-clip.js already makes.
  await runFFmpeg([
    '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
    outPath
  ]);
}

async function upload(finalPath, title, description) {
  const youtube = authorize();
  const sizeMb = Math.round((await fsp.stat(finalPath)).size / 1048576);
  logger.info(`Uploading (${sizeMb} MB)...`);

  const res = await youtube.videos.insert({
    part: 'snippet,status',
    requestBody: {
      snippet: {
        title, description, tags: ['shorts', 'top5'], categoryId: '17',
        defaultLanguage: 'en', defaultAudioLanguage: 'en'
      },
      status: { privacyStatus: 'private', selfDeclaredMadeForKids: false }
    },
    media: { body: fs.createReadStream(finalPath) }
  });

  const ledger = JSON.parse(await fsp.readFile(LEDGER_PATH, 'utf8').catch(() => '{}'));
  return { videoId: res.data.id, url: `https://www.youtube.com/watch?v=${res.data.id}`, ledger };
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag, def) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : def);
  const id = get('--id', `top5-${Date.now()}`);
  const count = Number(get('--count', '5'));
  const prefixes = get('--prefixes', 'kaisu,speedmessi,kaibodycam,kaitota').split(',');
  const theme = get('--theme', 'Kai Cenat & IShowSpeed');
  // Seconds of footage per pick. The winning Top 5 shorts run a median of 61s
  // in total, so five picks plus a short intro means roughly ten seconds each.
  const per = Number(get('--per', '10'));

  await fsp.mkdir(WORK_DIR, { recursive: true });

  const candidates = await loadCandidates(prefixes);
  logger.info(`${candidates.length} candidate clip(s) across prefixes: ${prefixes.join(', ')}`);
  if (candidates.length < count) throw new Error(`only ${candidates.length} candidates available, need ${count}`);

  // Ranking wants a text model, and every provider in the chain is rate-limited
  // or out of credit often enough that losing the whole edit to it is not
  // acceptable. The clips already carry titles written when they were cut, so
  // the fallback reuses those as the on-screen hooks rather than inventing
  // anything — the countdown order is then just the order they were made in.
  let picks;
  try {
    picks = await rankPicks(candidates, count, theme);
  } catch (error) {
    logger.warn(`ranking unavailable (${String(error.message).slice(0, 60)}) — using clip titles in order`);
    picks = candidates.slice(0, count).map((c, i) => ({
      ...c,
      rank: count - i,
      hook: c.title.replace(/\s*#\w+\s*$/g, '').trim()
    }));
  }
  logger.info('Countdown order:');
  picks.forEach(p => logger.info(`  #${p.rank} — ${p.id} — "${p.hook}" (${p.title})`));

  const sfx = await ensureSfx();
  const segments = [];

  // A short title beat only. Three seconds of black before anything happens was
  // a third of the running time the winning channels give to an entire pick.
  const introPath = path.join(WORK_DIR, `${id}_intro.mp4`);
  await makeCard(`TOP ${count}\n${theme.toUpperCase()}`, null, 1.4, introPath);
  segments.push(introPath);

  for (const pick of picks) {
    const pickPath = path.join(WORK_DIR, `${id}_pick${pick.rank}.mp4`);
    await buildPick(pick, per, sfx, pickPath);
    segments.push(pickPath);
    logger.info(`#${pick.rank} ${pick.id}: ${per}s`);
  }

  const finalPath = path.join(VIDEO_DIR, `${id}_short.mp4`);
  logger.info(`Concatenating ${segments.length} segment(s)...`);
  await concatSegments(segments, finalPath);

  const title = `TOP ${count} ${theme} Moments #Shorts`;
  const description = picks.map(p => `#${p.rank} ${p.hook} (from ${p.title})`).reverse().join('\n');

  // Build without posting. An edit worth watching before it goes anywhere near
  // a channel, and the clips are moving to their own channel anyway.
  if (args.includes('--no-upload')) {
    logger.success(`${id}: built at ${finalPath} — not uploaded (--no-upload)`);
    logger.info(`Title would be: "${title}"`);
    return;
  }

  const { videoId, url, ledger } = await upload(finalPath, title, description);

  ledger[id] = {
    videoId, url, privacyStatus: 'private', title,
    uploadedAt: new Date().toISOString(),
    source: 'compilation',
    includes: picks.map(p => ({ id: p.id, rank: p.rank, hook: p.hook }))
  };
  await fsp.writeFile(LEDGER_PATH, JSON.stringify(ledger, null, 2));
  logger.success(`${id} -> ${url} (private)`);
  logger.info(`Review it, then: node scripts/upload-shorts.js --publish ${id}`);
}

module.exports = { loadCandidates, rankPicks, makeCard, buildPick, ensureSfx, concatSegments, upload };

if (require.main === module) {
  main().catch(error => {
    logger.error(`make-top5 failed: ${error.message}`);
    process.exit(1);
  });
}
