/* global fetch, AbortSignal, URLSearchParams */
/**
 * Real footage of a story from Wikimedia Commons (asked for on 9 Nov 2026:
 * "get clips"). Clips taken from other YouTube channels would draw Content ID
 * claims and copyright strikes; Commons holds only free video: newsreels
 * (Universal Newsreel, public domain; Polygoon, CC BY-SA), and clubs' and
 * broadcasters' CC-licensed uploads (Real Madrid's own, news agencies).
 *
 * A video counts only when its title or description names the story's
 * subject, its year fits the episode, and it is not a video game, an
 * interview, a podcast, another sport or a women's/youth side. Commons' own
 * small transcodes are used (the 73s Munich 1958 newsreel is 2 MB at 480p),
 * read from the middle of the file with HTTP ranges: no full download.
 */
const path = require('path');
const fsp = require('fs').promises;
const { runFFmpeg } = require('./ffmpeg');

const UA = { 'User-Agent': 'yt-automation-research/1.0 (personal project)' };
const API = 'https://commons.wikimedia.org/w/api.php';

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ij/g, 'y');
const strip = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

// "France 98 v FIFA 98" is a video game; "Zack en Roue Libre" is a 78-minute interview.
const NOT_FOOTAGE = /\b(fifa ?\d{2}|pes ?\d{2,4}|efootball|video ?games?|gameplay|playstation|xbox|interview|entrevista|entretien|intervista|podcast|episode|s\d{2}e\d{1,3}|reaction|trailer|music video|unboxing|tutorial|lucha|wrestling|basketball|nba|nfl|american football|rugby|cricket|tennis|hockey|futsal|beach soccer|wom[ae]n'?s?|femenin\w*|feminin\w*|frauen|u-?1\d|u-?2\d|esports?|minecraft|roblox|lego|animation|animated|cartoon)\b/i;

// A football story's footage must say it is football somewhere: the
// "Cristiano Ronaldo" hit was a drone selfie at Madeira's airport, the
// "Spanien" one a folk band.
const FOOTBALL = /\b(soccer|football|futbol|fussball|fu.ball|voetbal|calcio|futebol|mundial|world cup|weltmeisterschaft|copa|euro ?20\d\d|uefa|fifa|champions league|liga|match|goal|goals|gol|stadium|stadion|estadio|fans?|supporters|elftal|wedstrijd|selecao|nationalmannschaft)\b/i;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** A Commons transcode to a local file, refused over 60 MB. */
async function fetchVideo(url, out, maxBytes = 60e6) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`video download ${res.status}`);
  if (Number(res.headers.get('content-length') || 0) > maxBytes) throw new Error('video over 60 MB');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error('video over 60 MB');
  await fsp.writeFile(out, buf);
  return out;
}

async function api(params) {
  // Commons answers 429 to a quick run of searches: pace them and retry.
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}?${new URLSearchParams({ format: 'json', ...params })}`, { headers: UA, signal: AbortSignal.timeout(30000) });
    if (res.ok) return res.json();
    if (res.status !== 429 || attempt >= 3) throw new Error(`Commons ${res.status}`);
    await pause(4000 * attempt);
  }
}

async function searchVideos(query, limit = 20) {
  const j = await api({
    action: 'query', generator: 'search', gsrnamespace: '6', gsrlimit: String(limit), gsrsearch: `${query} filetype:video`,
    prop: 'videoinfo', viprop: 'url|size|derivatives|extmetadata',
    viextmetadatafilter: 'ImageDescription|LicenseShortName|Artist|DateTimeOriginal'
  });
  return Object.values(j.query?.pages || {}).map((p) => {
    const v = (p.videoinfo || [])[0] || {};
    const md = v.extmetadata || {};
    const title = p.title.replace(/^File:/, '');
    const date = strip(md.DateTimeOriginal?.value);
    // The title's year first: "All 48 goals ... (2014-15)" was uploaded in 2018.
    const year = Number((title.match(/\b(18[89]\d|19\d\d|20\d\d)\b/) || date.match(/\b(18[89]\d|19\d\d|20\d\d)\b/) || [])[1]) || null;
    const derivs = (v.derivatives || []).filter((d) => /webm|mp4/.test(d.type) && d.height >= 240).sort((a, b) => a.height - b.height);
    const pick = derivs.find((d) => d.height >= 360) || derivs.at(-1);
    return {
      title, desc: strip(md.ImageDescription?.value).slice(0, 600), year, duration: Number(v.duration) || 0,
      src: pick?.src || v.url, license: strip(md.LicenseShortName?.value) || 'see Commons',
      artist: strip(md.Artist?.value).slice(0, 80) || 'unknown', url: v.descriptionurl || `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(title)}`
    };
  });
}

/**
 * Footage for a story: { queries, keys, year } where every key must appear as
 * a word start in the title or description, and the year (when known) within
 * one of the episode's. Returns up to `max`, closest year first, then shortest
 * (a 2-minute newsreel item is about one thing; a 20-minute show is not).
 */
async function findFootage({ queries, keys, year = null, max = 2, topic = FOOTBALL, logger = console }) {
  const seen = new Map();
  for (const q of queries) {
    try {
      // one video in two formats (.webm and .ogv), or an "unedited" copy, is one video
      for (const v of await searchVideos(q)) {
        const id = fold(v.title.replace(/\.(webm|ogv|ogg|mp4|mpe?g)$/i, '')).replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 30);
        if (!seen.has(id)) seen.set(id, v);
      }
    } catch (e) { logger.warn?.(`archive: search "${q}" failed (${String(e.message).slice(0, 80)})`); }
    await pause(1200);
  }
  const has = (text, k) => new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text);
  const ok = [...seen.values()].filter((v) => {
    const text = fold(`${v.title} ${v.desc}`);
    if (!keys.length || !keys.every((k) => has(text, fold(k)))) return false;
    if (topic && !topic.test(text)) return false;
    if (NOT_FOOTAGE.test(`${v.title} ${v.desc}`)) return false;
    if (!v.src || v.duration < 4 || v.duration > 1200) return false;
    // undated footage cannot be vouched for in a dated story
    if (year && (!v.year || Math.abs(v.year - year) > 1)) return false;
    return true;
  });
  ok.sort((a, b) => (year ? Math.abs(a.year - year) - Math.abs(b.year - year) : 0) || a.duration - b.duration);
  if (ok.length) logger.info?.(`archive: ${ok.length} video(s) of the story on Commons: ${ok.slice(0, max).map((v) => `"${v.title.slice(0, 60)}" (${v.year || '?'}, ${Math.round(v.duration)}s)`).join(', ')}`);
  return ok.slice(0, max);
}

// Where real footage belongs: the action, the aftermath, the crowd.
const FOOTAGE_WORDS = /^(goal|goals|scored|scores|scoring|header|headed|penalty|penalties|shootout|final|won|win|wins|trophy|crash|crashed|collapsed|collapse|died|death|dead|killed|fans|crowd|supporters|celebrated|celebrations?|tribute|memorial|funeral|mourned|mourning|stadium|match|kick-off|kickoff|minute|minutes|plane|disaster|riot|riots|stands)$/;
const bare = (w) => String(w).toLowerCase().replace(/[^a-z0-9'-]/g, '').replace(/'s$/, '');

/**
 * Splice archive videos into a v2 shot list: each at a footage word after
 * the hook (never on a name's face beat, 6s apart), up to 3s, the whole
 * frame shown over a blurred copy of itself so a 4:3 newsreel is not cropped
 * to a sliver. Shots carry `archive` for the credits and the AI reviewer.
 */
async function addArchive(shots, words, archive, { chapters = [], hookEnd = 2.4, workDir, logger = console } = {}) {
  if (!archive?.length) return shots;
  const total = shots.at(-1).end;
  const faces = chapters.filter((c) => c.photos).map((c) => [c.at, c.at + 1.2]);
  const moments = [];
  for (const w of words) {
    if (moments.length >= archive.length) break;
    if (w.start < hookEnd + 0.6 || w.start > total - 2.2) continue;
    if (!FOOTAGE_WORDS.test(bare(w.word))) continue;
    if (faces.some(([a, b]) => w.start >= a && w.start < b)) continue;
    if (moments.length && w.start - moments.at(-1) < 6) continue;
    moments.push(w.start);
  }
  let out = shots.slice();
  const r3 = (x) => Number(x.toFixed(3));
  for (const [i, at] of moments.entries()) {
    const v = archive[i];
    try {
      const nextName = chapters.find((c) => c.photos && c.at > at + 0.3)?.at ?? Infinity;
      const start = at;
      const stop = Math.min(at + 3.0, nextName, total);
      if (stop - start < 1.6) continue;
      const span = stop - start;
      const from = v.duration <= 8 ? 0.3 : Math.min(Math.max(3, v.duration * 0.2), v.duration - span - 0.3);
      const clip = path.join(workDir, `archive${i}.mp4`);
      // Read from a local copy: ffmpeg on the runner failed reading Commons'
      // URL directly (Juventus-Cagliari, 10 Nov). The transcodes are small.
      const local = await fetchVideo(v.src, path.join(workDir, `archive-src${i}${path.extname(new URL(v.src).pathname) || '.webm'}`));
      await runFFmpeg(['-y', '-loglevel', 'error', '-ss', from.toFixed(2), '-i', local, '-t', (span + 0.1).toFixed(3), '-an',
        '-filter_complex', '[0:v]split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:2[bg];'
          + '[b]scale=1080:1920:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=30,format=yuv420p',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', clip]);
      const shot = {
        video: clip, image: `archive:${v.title}`, mode: 'bleed', face: null, tight: 1.0, start: r3(start), end: r3(stop),
        zoom: [1.0, 1.04], pan: 0, transition: 'punch', archive: { title: v.title, artist: v.artist, license: v.license, url: v.url }
      };
      const kept = [];
      for (const s of out) {
        if (s.end <= start || s.start >= stop) { kept.push(s); continue; }
        if (s.start < start) kept.push({ ...s, end: r3(start) });
        if (s.end > stop) kept.push({ ...s, start: r3(stop), transition: 'punch' });
      }
      out = [...kept, shot].sort((a, b) => a.start - b.start);
      logger.info?.(`archive at ${at.toFixed(1)}s: "${v.title.slice(0, 80)}" from ${from.toFixed(1)}s`);
    } catch (e) {
      // ffmpeg's own words, not just "Command failed: <the command>"
      const why = String(e.stderr || '').trim().split('\n').slice(-2).join(' ') || String(e.message);
      logger.warn?.(`archive skipped at ${at.toFixed(1)}s: ${why.slice(0, 200)}`);
    }
  }
  return out;
}

module.exports = { findFootage, searchVideos, addArchive, NOT_FOOTAGE, FOOTBALL };
