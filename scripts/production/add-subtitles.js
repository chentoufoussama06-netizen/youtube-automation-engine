#!/usr/bin/env node
/**
 * Upload translated subtitle TRACKS to an already-published short.
 *
 *   node scripts/add-subtitles.js foe --langs es,pt,ar,fr
 *
 * This does NOT touch the burned-in English captions in the video itself —
 * those are pixels now, permanent. What this adds is a separate, real
 * YouTube caption track per language: machine-readable text YouTube can
 * index for search in that language and a viewer can toggle on. Cheap
 * relative to dubbing a second narration track, and the first thing worth
 * trying before that bigger build.
 *
 * Source timing comes from the short's own burned-caption file
 * (data/shorts/captions/<id>_short.ass), which already carries real
 * word-level timestamps. Chunks are merged back into full sentences before
 * translation — translating isolated 2-3 word fragments independently
 * produces garbage; a full sentence has context. The merged sentence's
 * start/end (first chunk's start, last chunk's end) becomes the subtitle
 * cue's timing, so playback still lines up even though the original
 * staccato word-by-word rhythm isn't preserved in the translated track —
 * that rhythm is a burned-in stylistic choice, not something a toggleable
 * subtitle track needs to reproduce.
 */

require('dotenv').config();

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { google } = require('googleapis');
const { AITextService } = require('../../utils/ai-text-service');
const { Logger } = require('../../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const DATA_ROOT = process.env.DATA_ROOT || 'data';
const YT_TOKENS_FILE = process.env.YT_TOKENS_FILE || 'tokens.json';
const LEDGER_PATH = path.join(ROOT, DATA_ROOT, 'shorts', 'uploads.json');
const CAPTIONS_DIR = path.join(ROOT, DATA_ROOT, 'shorts', 'captions');

// BCP-47 codes YouTube's captions.insert accepts. Kept broader than
// DEFAULT_LANGS (below) on purpose: a one-off clip can ask for the whole
// set via --langs without changing the automated daily-publish default that
// DEFAULT_LANGS drives (see CAPTIONS_COST in upload-shorts.js — every extra
// default language shrinks how many shorts the fixed 10,000-unit/day YouTube
// Data API quota lets that batch publish).
const LANG_NAMES = {
  es: 'Spanish', fr: 'French', ar: 'Arabic', pt: 'Portuguese', 'pt-BR': 'Portuguese (Brazil)',
  'zh-Hans': 'Chinese (Simplified)', 'zh-Hant': 'Chinese (Traditional)',
  hi: 'Hindi', ur: 'Urdu', bn: 'Bengali', id: 'Indonesian', vi: 'Vietnamese', th: 'Thai', fil: 'Filipino',
  de: 'German', it: 'Italian', ru: 'Russian', tr: 'Turkish', ja: 'Japanese', ko: 'Korean'
};

/** Every language this script knows how to translate into — the "reach everyone" shortcut for --langs. */
const ALL_LANGS = Object.keys(LANG_NAMES);

const logger = new Logger('AddSubtitles');

function authorize() {
  const creds = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'credentials.json'), 'utf8')).youtube;
  const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', YT_TOKENS_FILE), 'utf8')).youtube;
  const oauth = new google.auth.OAuth2(creds.client_id, creds.client_secret, (creds.redirect_uris || [])[0]);
  oauth.setCredentials(tokens);
  return google.youtube({ version: 'v3', auth: oauth });
}

/** ASS time "H:MM:SS.CC" -> seconds. */
function assTimeToSeconds(t) {
  const [h, m, s] = t.split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/** Seconds -> SRT time "HH:MM:SS,mmm". */
function toSrtTime(seconds) {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/** Parse the burned-caption .ass file into raw {start,end,text} chunks. */
async function parseAssChunks(assPath) {
  const raw = await fsp.readFile(assPath, 'utf8');
  const chunks = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('Dialogue:')) continue;
    const fields = line.slice('Dialogue:'.length).split(',');
    const start = assTimeToSeconds(fields[1].trim());
    const end = assTimeToSeconds(fields[2].trim());
    const text = fields.slice(9).join(',').trim();
    if (text) chunks.push({ start, end, text });
  }
  return chunks;
}

/** Merge 2-3 word burned-caption chunks back into full sentences for translation. */
function mergeIntoSentences(chunks) {
  const sentences = [];
  let acc = [];
  for (const chunk of chunks) {
    acc.push(chunk);
    if (/[.!?]$/.test(chunk.text)) {
      sentences.push({ start: acc[0].start, end: acc[acc.length - 1].end, text: acc.map(c => c.text).join(' ') });
      acc = [];
    }
  }
  if (acc.length) {
    sentences.push({ start: acc[0].start, end: acc[acc.length - 1].end, text: acc.map(c => c.text).join(' ') });
  }
  return sentences;
}

async function translateSentences(service, sentences, langCode) {
  const langName = LANG_NAMES[langCode] || langCode;
  const prompt = `Translate each of these ${sentences.length} English subtitle lines into natural, `
    + `fluent ${langName}. Keep the same sentence order and count exactly — one translation per line, `
    + 'no merging or splitting. This is documentary narration about a real event; keep names, dates and '
    + "numbers accurate and unchanged where they're proper nouns or figures.\n\n"
    + sentences.map((s, i) => `${i + 1}. ${s.text}`).join('\n')
    + `\n\nReturn only valid JSON: { "translations": ["...", "..."] } — exactly ${sentences.length} strings, in order.`;

  const raw = await service.generateText(prompt, { maxTokens: 2000, temperature: 0.3, json: true });
  const text = String(raw).replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text);
  const translations = parsed.translations || [];
  if (translations.length !== sentences.length) {
    throw new Error(`translation count mismatch: got ${translations.length}, expected ${sentences.length}`);
  }
  return translations;
}

function buildSrt(sentences, translations) {
  return sentences.map((s, i) => `${i + 1}\n${toSrtTime(s.start)} --> ${toSrtTime(s.end)}\n${translations[i]}\n`).join('\n');
}

const DEFAULT_LANGS = ['es', 'pt', 'ar', 'fr'];

/**
 * Translate and upload caption tracks for one already-uploaded short.
 * Exported so upload-shorts.js can call this right after a fresh upload —
 * new shorts get subtitles as part of the normal publish flow instead of
 * needing a separate manual pass. `youtube` is accepted as a param so a
 * caller that's already authorized doesn't pay for a second OAuth client.
 */
async function addSubtitlesForJob(jobId, langs = DEFAULT_LANGS, youtube = null) {
  const ledger = JSON.parse(await fsp.readFile(LEDGER_PATH, 'utf8'));
  const entry = ledger[jobId];
  if (!entry) throw new Error(`no uploaded short called "${jobId}"`);

  const assPath = path.join(CAPTIONS_DIR, `${jobId}_short.ass`);
  const chunks = await parseAssChunks(assPath);
  const sentences = mergeIntoSentences(chunks);
  logger.info(`${jobId}: ${chunks.length} burned-caption chunks -> ${sentences.length} sentences`);

  const service = new AITextService({});
  if (!service.isAvailable()) throw new Error('no text-generation provider configured');
  const yt = youtube || authorize();

  const srtDir = path.join(CAPTIONS_DIR, 'translated');
  await fsp.mkdir(srtDir, { recursive: true });

  const results = [];
  for (const lang of langs) {
    try {
      const translations = await translateSentences(service, sentences, lang);
      const srt = buildSrt(sentences, translations);
      const srtPath = path.join(srtDir, `${jobId}_${lang}.srt`);
      await fsp.writeFile(srtPath, srt);

      await yt.captions.insert({
        part: 'snippet',
        requestBody: {
          snippet: { videoId: entry.videoId, language: lang, name: LANG_NAMES[lang] || lang, isDraft: false }
        },
        media: { body: fs.createReadStream(srtPath) }
      });
      logger.success(`${jobId}: ${LANG_NAMES[lang] || lang} (${lang}) caption track uploaded`);
      results.push({ lang, ok: true });
    } catch (error) {
      logger.error(`${jobId}: ${lang} failed: ${String(error.message).slice(0, 150)}`);
      results.push({ lang, ok: false, error: error.message });
    }
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const jobId = args.find(a => !a.startsWith('--'));
  const langsArg = args.includes('--langs') ? args[args.indexOf('--langs') + 1] : DEFAULT_LANGS.join(',');
  const langs = langsArg === 'all' ? ALL_LANGS : langsArg.split(',');
  if (!jobId) throw new Error('usage: node scripts/add-subtitles.js <jobId> [--langs es,fr,ar,pt,pt-BR,zh-Hans,... | all]');
  await addSubtitlesForJob(jobId, langs);
}

module.exports = { addSubtitlesForJob, DEFAULT_LANGS, ALL_LANGS, LANG_NAMES };

if (require.main === module) {
  main().catch(error => {
    logger.error(`add-subtitles failed: ${error.message}`);
    process.exit(1);
  });
}
