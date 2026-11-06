/**
 * Story short, second look.
 *
 * Measured on two real uploads (2026-10-30, Kane and Elagabalus Part 2): the
 * v1 render put each landscape photo in a thin band over a blurred copy of
 * itself, so two-thirds of the screen was blur; it drifted 10-14 pixels and
 * hard-cut every 3.5 seconds; it reused one coin and one bust a dozen times in
 * 40 seconds; the first frame was whatever photo came first (a mural); and it
 * carried no sound but the voice. This builds the same story as:
 *
 *   - full-frame 9:16 crops framed on the subject's face (cards for photos that
 *     cannot fill the frame), moved, punched and whip-panned smoothly;
 *   - cuts on the narration's own word timings, ~2s apart, no back-to-back repeats;
 *   - a hook: the strongest face plus the title as a headline for the first beat;
 *   - captions of 1-3 words that never end on "the" or "and", the spoken word
 *     popping in the lane's colour, and big cards for the story's numbers;
 *   - a synthesised music bed ducked under the voice, whooshes on cuts, an impact
 *     on the hook and the numbers, a riser into the last sentence.
 *
 * Frames and sound are made by scripts/production/compose_short.py (OpenCV +
 * numpy); this file plans them and assembles the result with ffmpeg + libass.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawnSync } = require('child_process');
const { getFFmpegPath, runFFmpeg } = require('./ffmpeg');
const { addClips } = require('./broll');

const ROOT = path.join(__dirname, '..');
const COMPOSE = path.join(ROOT, 'scripts', 'production', 'compose_short.py');
const FONTS_DIR = path.join(ROOT, 'assets', 'fonts');
const PYTHON = process.env.PYTHON_BIN || 'python';

const LOOKS = {
  football: { hookBox: '&H002A2AE0&', hookText: '&H00FFFFFF&' },   // red box, white text
  ancient: { hookBox: '&H0033BBEE&', hookText: '&H00101010&' }     // gold box, near-black text
};

const STOP = new Set(('the a an and of to in on at for his her its with by from as but or was is were '
  + 'their he she it that this who which into than then').split(' '));
const bare = (w) => String(w).toLowerCase().replace(/[^a-z0-9']/g, '');

function python(args) {
  // -P keeps the script's own folder off the import path.
  const res = spawnSync(PYTHON, ['-P', COMPOSE, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`compose_short.py ${args[0]} failed: ${(res.stderr || res.error?.message || '').slice(-400)}`);
  return res.stdout;
}

/** Faces and sharpness for each photo (pixels in the photo's own size). */
function analyzePhotos(paths) {
  return JSON.parse(python(['analyze', ...paths]));
}

/** Rank photos: a clear, large face first; the best one opens the video. */
function rankPhotos(metas) {
  return Object.entries(metas).map(([p, m]) => {
    // A full-frame crop is only safe framed on ONE face. Without a face, the
    // centre of a wide stadium photo is grass; in a line-up, the biggest face
    // is a child mascot, not the player (both Kane v2 test). So a photo fills
    // the frame only when one face clearly dominates; otherwise it is a card
    // showing the whole picture.
    // With the face models, `subject` is the face matched across the story's
    // photos (compose_short.py analyze); without them, the dominant face.
    const area = (f) => (f ? f[2] * f[3] : 0);
    const solo = m.faces.length === 1 || (m.faces.length > 1 && area(m.faces[0]) >= 2.5 * area(m.faces[1]));
    let face = 'subject' in m ? m.subject : (solo ? m.faces[0] : null);
    const faceShare = face ? area(face) / (m.w * m.h) : 0;
    // No face to frame on, but the depth map found the action (two players
    // on a ball, compose_short.py foreground) and it fits a 9:16 crop: fill
    // the frame on it instead of boxing a wide photo in dark space.
    const window = Math.min(m.w, m.h * 9 / 16);
    const action = !face && m.fg && m.h >= 900 && m.fg[2] <= window * 1.1 && m.fg[3] >= m.h * 0.2;
    if (action) face = m.fg;
    const card = m.h < 900 || !face;
    // Room above the face: the opener's headline sits over the top quarter.
    const headroom = face ? (face[1] + face[3] / 2) / m.h : 0;
    const score = (face ? (action ? 1 : 2) : 0) + Math.min(faceShare * 60, 3) + Math.min(m.sharp / 400, 1) - (card ? 1.5 : 0);
    return { path: p, meta: m, face, card, headroom, score, action: Boolean(action) };
  }).sort((a, b) => b.score - a.score);
}

/** The opening shot: the best face that leaves room for the headline above it. */
function opener(ranked) {
  // A real face opens, and only one the hook headline (top ~23% of the
  // frame) will not cover: Real Madrid Part 2's opener was a tight Rodrygo
  // crop with the face at the top edge, and the headline sat on his eyes.
  // A depth-found action shot only when there is no face.
  const clear = (r) => faceTopInFrame(r) >= 0.24;
  return ranked.find((r) => !r.card && !r.action && clear(r))
    || ranked.find((r) => !r.card && !r.action && r.headroom >= 0.3) || ranked.find((r) => !r.card && !r.action)
    || ranked.find((r) => !r.card) || ranked[0];
}

/**
 * Where the top of the face lands in the opening frame (0 = top), framed as
 * compose_short.py window_for frames a hook shot: face 10% below centre,
 * window clamped to the photo, at the opener's starting zoom.
 */
function faceTopInFrame(r, zoom = 1.22) {
  const m = r.meta;
  const f = r.face;
  if (!f) return 0;
  const chz = Math.min(m.h, m.w * 16 / 9) / zoom;
  const fy = f[1] + f[3] / 2;
  const cy = Math.min(Math.max(fy - Math.min(m.h, m.w * 16 / 9) * 0.10, chz / 2), m.h - chz / 2);
  return (f[1] - (cy - chz / 2)) / chz;
}

/**
 * Cut points on word starts, about every `target` seconds, preferring the
 * start of a sentence or clause so the picture changes when the thought does.
 */
function cutTimes(words, duration, { target = 2.1, min = 1.4, max = 2.9 } = {}) {
  const cuts = [0];
  let last = 0;
  for (let i = 1; i < words.length; i++) {
    const t = words[i].start;
    const gap = t - last;
    const afterSentence = /[.!?]["'”’]?$/.test(words[i - 1].word);
    const afterClause = /[,;:—]$/.test(words[i - 1].word);
    if (gap >= max || (gap >= min && afterSentence) || (gap >= target && afterClause) || gap >= target + 0.35) {
      cuts.push(t);
      last = t;
    }
  }
  if (duration - last < min && cuts.length > 1) cuts.pop();
  return cuts;
}

/**
 * `chapters` ([{ at, photos }], seconds and photo paths) pins each stretch of
 * narration to its own photos — the roundup's "Number four: Fermín López"
 * must show López, not whichever photo ranks best overall. Chapter starts are
 * also forced cuts, so the picture changes on "Number four".
 */
function planShots(words, duration, ranked, chapters = [], claimed = null) {
  const forced = chapters.map((c) => c.at).filter((t) => t > 0.5 && t < duration - 1);
  // A regular cut just before a chapter start would leave a flash of a shot.
  const cuts = [...new Set([...cutTimes(words, duration).filter((t) => t === 0 || !forced.some((f) => Math.abs(f - t) < 0.8)), ...forced])]
    .sort((a, b) => a - b);
  const chapterAt = (t) => [...chapters].reverse().find((c) => c.at <= t + 0.05);
  // Before the first chapter (the intro), only the photos no chapter claims.
  // `claimed` is every photo tied to a name, said or not: a name the
  // narration never says keeps its photos off screen. Part 1 of Real Madrid
  // 2022 never named Mbappe, yet his photos filled the gaps between Benzema's.
  // With nothing unclaimed, the gaps show the first name said (the subject).
  const isClaimed = (p) => (claimed ? claimed.has(p) : chapters.some((c) => c.photos?.includes(p)));
  let intro = null;
  if (chapters.length || claimed?.size) {
    const free = ranked.map((r) => r.path).filter((p) => !isClaimed(p));
    intro = { photos: free.length ? free : (chapters.find((c) => c.photos?.length)?.photos || ranked.map((r) => r.path)) };
  }
  const uses = new Map();
  const shots = [];
  let prev = null;
  for (let i = 0; i < cuts.length; i++) {
    const start = cuts[i];
    const end = i + 1 < cuts.length ? cuts[i + 1] : duration;
    // A released name stretch (photos: null) is back to the intro's photos.
    const found = chapterAt(start);
    const ch = found?.photos ? found : intro;
    const pool = ch ? ranked.filter((r) => ch.photos.includes(r.path)) : ranked;
    const safe = intro ? ranked.filter((r) => intro.photos.includes(r.path)) : ranked;
    const from = pool.length ? pool : (safe.length ? safe : ranked);
    // The opener is the best photo; after that, the least-used photo that is
    // not the one just shown, best-ranked first.
    const pick = i === 0 ? opener(from) : [...from]
      .filter((r) => r.path !== prev || from.length === 1)
      .sort((a, b) => (uses.get(a.path) || 0) - (uses.get(b.path) || 0) || b.score - a.score)[0] || ranked[0];
    const n = uses.get(pick.path) || 0;
    uses.set(pick.path, n + 1);
    prev = pick.path;
    // A reused photo is framed tighter and moves the other way, so it reads as a new shot.
    const zoomIn = (i + n) % 2 === 0;
    shots.push({
      image: pick.path,
      mode: pick.card ? 'card' : 'bleed',
      face: pick.face || null,
      tight: n > 0 && pick.face && !pick.card ? 0.84 : 1.0,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      zoom: i === 0 ? [1.22, 1.04] : (zoomIn ? [1.02, 1.12] : [1.13, 1.03]),
      pan: i % 2 === 0 ? 1 : -1,
      transition: i > 0 && i % 3 === 0 ? 'whip' : 'punch',
      hook: i === 0
    });
  }
  return shots;
}

/**
 * The story's numbers as big cards on the word that says them: plain numbers
 * ("61 goals", "2001"), and for football what a match edit puts on screen — a
 * scoreline ("3–1"), a match minute ("90th minute" -> 90'), a hat-trick. Only
 * what the narration itself says, so a card is never a guess.
 */
function statCards(words, hookEnd) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const raw = words[i].word.replace(/[.,!?;:]+$/, '');
    const next = words[i + 1] ? bare(words[i + 1].word) : '';
    let text = null;
    let strong = false;
    // A scoreline or odds ("3–1", "5000–1"), never a season ("2014–15").
    const score = /^(\d{1,4})[–-](\d{1,2})$/.exec(raw);
    const minute = /^(\d{1,3})(st|nd|rd|th)$/i.exec(raw);
    if (score && !/^(1[89]|20)\d\d$/.test(score[1])) {
      text = `${score[1]}–${score[2]}`;
      strong = true;
    } else if (minute && /^minutes?$/.test(next)) {
      text = `${minute[1]}'`;
      strong = true;
    } else if (/^hat-?tricks?$/i.test(raw)) {
      text = 'HAT-TRICK';
      strong = true;
    } else if (/^\d[\d,.]*$/.test(raw) && raw.replace(/\D/g, '').length >= 2) {
      // Only a word that IS a number. Edge sometimes hands a whole date over as
      // one word ("26 October 2026,"), and stripping its letters made "262026".
      const isYear = /^(1[89]|20)\d\d$/.test(raw);
      const label = !isYear && next && !STOP.has(next) && /^[a-z]+$/.test(next) ? ` ${next.toUpperCase()}` : '';
      text = `${raw}${label}`;
    }
    if (!text) continue;
    const t = words[i].start;
    // Match moments come thick and fast ("3–1 away, then 2–3 at home"), so they
    // may sit closer together than the plain numbers.
    if (t < hookEnd + 0.3 || out.some((c) => Math.abs(c.t - t) < (strong ? 1.6 : 3))) continue;
    out.push({ t, text });
    if (out.length >= 6) break;
  }
  return out;
}

/** Captions in 1-3 word chunks that never end on a dangling "the" or "and". */
function chunkWords(words) {
  const chunks = [];
  let cur = [];
  for (let i = 0; i < words.length; i++) {
    cur.push(words[i]);
    const w = words[i].word;
    const ends = /[.!?,;:—]["'”’]?$/.test(w);
    const len = cur.map((c) => c.word).join(' ').length;
    const full = cur.length >= 3 || len >= 14;
    // Carrying a dangling "the" onto the next word is worth a slightly longer
    // chunk, but not one that would have to shrink to fit (~20 characters).
    const dangling = STOP.has(bare(w)) && !ends && i + 1 < words.length && cur.length < 5 && len < 20;
    if ((ends || full) && !dangling) {
      chunks.push(cur);
      cur = [];
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function assTime(s) {
  const v = Math.max(0, s);
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${(v % 60).toFixed(2).padStart(5, '0')}`;
}

const assText = (s) => String(s).replace(/[{}\\]/g, '').replace(/\s+/g, ' ').trim();

// Anton's advance widths at size 100, measured from the font file. WrapStyle 2
// never wraps, so a caption wider than the frame is simply cut off at both
// edges — at size 124, "KANE DOMINATED THE OPPOSITION." measured 1,560px on a
// 1,080px frame, and every preview had clipped lines. Each line is sized to fit.
const ANTON = { ' ': 23, A: 49, B: 48, C: 47, D: 49, E: 41, F: 40, G: 48, H: 50, I: 23, J: 47, K: 47, L: 40, M: 75, N: 50, O: 49, P: 47, Q: 49, R: 48, S: 46, T: 40, U: 47, V: 47, W: 71, X: 48, Y: 45, Z: 41, 1: 33, '.': 23, ',': 24, '!': 23, "'": 21, '’': 23, '"': 43, '-': 31, ':': 24, ';': 25, '%': 106, '&': 52, '(': 29, ')': 29, '/': 41 };
const textWidth = (s, size) => [...String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')]
  .reduce((w, ch) => w + (ANTON[ch] ?? (/\d/.test(ch) ? 49 : 47)), 0) * size / 100;
/** The largest size up to `base` at which `text`, scaled by `pop`, fits `maxPx`. */
const fitSize = (text, base, maxPx, pop = 1) => Math.max(40, Math.min(base, Math.floor(base * maxPx / (textWidth(text, base) * pop || 1))));

/** Two balanced lines for the hook headline. */
function twoLines(title) {
  const words = assText(title).toUpperCase().split(' ');
  if (words.length < 4) return [words.join(' ')];
  let best = 1;
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const diff = Math.abs(textWidth(words.slice(0, i).join(' '), 100) - textWidth(words.slice(i).join(' '), 100));
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')];
}

function buildAss({ words, title, accent, look, hookEnd, stats, tag, label = null, next = null }) {
  const L = LOOKS[look] || LOOKS.football;
  const header = [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1080', 'PlayResY: 1920', 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,'
      + 'ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    // Captions sit at ~62% height: below the face, above YouTube's title and buttons.
    // Anton is condensed, so it needs more size than v1's Arial Black to read as large.
    'Style: Cap,Anton,124,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,1,0,1,8,4,5,50,50,0,1',
    `Style: Hook,Anton,116,${L.hookText},&H000000FF,${L.hookBox},&H00000000,0,0,0,0,100,100,1,0,3,24,0,8,60,60,0,1`,
    `Style: Stat,Anton,200,${accent},&H000000FF,&H00000000,&H78000000,0,0,0,0,100,100,2,0,1,9,6,5,40,40,0,1`,
    'Style: Tag,Anton,54,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,2,0,1,4,0,8,60,60,0,1',
    `Style: Label,Anton,46,${accent},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,1,0,1,3,0,8,60,60,0,1`,
    `Style: Next,Anton,150,${L.hookText},&H000000FF,${L.hookBox},&H00000000,0,0,0,0,100,100,2,0,3,30,0,5,60,60,0,1`,
    '', '[Events]', 'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text'
  ];
  const ev = [];

  // The hook box adds 24px of padding a side inside 60px margins: 912px for text.
  const hook = twoLines(title);
  const hookSize = fitSize(hook.reduce((a, b) => (textWidth(a, 100) >= textWidth(b, 100) ? a : b)), 116, 900);
  ev.push(`Dialogue: 3,${assTime(0)},${assTime(hookEnd)},Hook,,0,0,0,,`
    + `{\\pos(540,250)\\fs${hookSize}\\fscx125\\fscy125\\t(0,180,\\fscx100\\fscy100)\\fad(0,180)}${hook.join('\\N')}`);
  if (tag) ev.push(`Dialogue: 2,${assTime(hookEnd)},${assTime(words.at(-1).end + 0.4)},Tag,,0,0,0,,{\\pos(540,230)\\fad(200,0)}${assText(tag).toUpperCase()}`);
  // What match or season this is, under the tag ("REAL MADRID V PSG · 2022").
  if (label) {
    const text = assText(label).toUpperCase();
    ev.push(`Dialogue: 2,${assTime(hookEnd)},${assTime(words.at(-1).end + 0.4)},Label,,0,0,0,,{\\pos(540,${tag ? 296 : 230})\\fs${fitSize(text, 46, 900)}\\fad(200,0)}${text}`);
  }
  // The next part, boxed like the hook, from when the voice says "Part two" to
  // the last frame, with one pulse: the thing a viewer must not miss. Between
  // the face and the captions (at 760 it sat on Vardy's face).
  if (next) {
    const text = assText(next.text).toUpperCase();
    ev.push(`Dialogue: 5,${assTime(next.at)},${assTime(words.at(-1).end + 0.6)},Next,,0,0,0,,`
      + `{\\pos(540,975)\\fs${fitSize(text, 150, 860)}\\fscx140\\fscy140\\t(0,200,\\fscx100\\fscy100)\\t(600,900,\\fscx106\\fscy106)\\t(900,1200,\\fscx100\\fscy100)}${text}`);
  }

  for (const s of stats) {
    const text = assText(s.text);
    ev.push(`Dialogue: 4,${assTime(s.t)},${assTime(s.t + 1.5)},Stat,,0,0,0,,`
      + `{\\pos(540,700)\\fs${fitSize(text, 200, 960)}\\frz-3\\fscx150\\fscy150\\t(0,140,\\fscx100\\fscy100)\\fad(0,220)}${text}`);
  }

  for (const chunk of chunkWords(words)) {
    const clean = chunk.map((c) => assText(c.word).toUpperCase());
    // Sized for the whole chunk with its spoken word popped to 114%.
    const capSize = fitSize(clean.join(' '), 124, 980, 1.14);
    for (let i = 0; i < chunk.length; i++) {
      const start = chunk[i].start;
      const end = i < chunk.length - 1 ? chunk[i + 1].start : chunk.at(-1).end + 0.08;
      const line = clean.map((w, j) => (j === i
        ? `{\\c${accent}\\fscx100\\fscy100\\t(0,70,\\fscx114\\fscy114)\\t(70,160,\\fscx106\\fscy106)}${w}{\\c&HFFFFFF&\\fscx100\\fscy100}`
        : w)).join(' ');
      const enter = i === 0 ? '\\fscx88\\fscy88\\t(0,80,\\fscx100\\fscy100)' : '';
      ev.push(`Dialogue: 1,${assTime(start)},${assTime(end)},Cap,,0,0,0,,{\\pos(540,1190)\\fs${capSize}${enter}}${line}`);
    }
  }
  return [...header, ...ev].join('\n');
}

/** ffmpeg filter-graph path: relative where possible (no drive colon to escape). */
function filterPath(p) {
  const rel = path.relative(process.cwd(), p).replace(/\\/g, '/');
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');
}

/** BGR tuple from an ASS colour like &H004040FF&. */
function bgrOf(assColour) {
  const hex = String(assColour).replace(/[^0-9A-Fa-f]/g, '').slice(-6).padStart(6, '0');
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

/**
 * Render a story short in the v2 look.
 *   words       narration word timings (narrateWithTiming)
 *   audioPath   narration audio
 *   photos      photo file paths
 *   look        'football' | 'ancient'
 *   accent      ASS colour for highlights (a lane's captionHighlight)
 *   tag         optional persistent label after the hook, e.g. "Part 2"
 *   label       optional line under it naming the match or season
 *   next        optional end card text, e.g. "Part 2", shown from the spoken "Part"
 */
/**
 * Chapters -> [{ at, photos }] for planShots. Two kinds:
 *   { cue: 'five', photos }        a countdown: starts when the narration says
 *                                  "Number five" (romano-weekly.js)
 *   { names: ['rodrygo'], photos } a person or thing: starts EVERY time the
 *                                  narration names it, so the picture follows
 *                                  the story — "Rodrygo came off the bench" is
 *                                  Rodrygo on screen, not whoever ranked best.
 * Cues it never says are dropped. A name said again while its own photos are
 * already up changes nothing, and a switch under 1.2s after the last one is
 * skipped, so two names in one breath do not flash.
 */
function resolveChapters(words, chapters) {
  const out = [];
  for (const c of chapters) {
    if (c.cue) {
      const i = words.findIndex((w, k) => /^number$/i.test(bare(w.word)) && bare(words[k + 1]?.word || '') === c.cue);
      if (i >= 0) out.push({ at: words[i].start, photos: c.photos });
      continue;
    }
    const names = (c.names || []).map((n) => bare(n)).filter(Boolean);
    words.forEach((w) => { if (names.includes(bare(w.word).replace(/'s$/, ''))) out.push({ at: w.start, photos: c.photos, named: true }); });
  }
  out.sort((a, b) => a.at - b.at);
  // A name holds its photos for NAME_HOLD seconds after it was last said, then
  // the picture goes back to the general shots (photos: null): in the first
  // Leicester preview "table" put Schmeichel up for 25 seconds straight.
  const NAME_HOLD = 6;
  const kept = [];
  for (const c of out) {
    const last = kept.at(-1);
    if (last && last.photos === c.photos && c.at < last.until) { last.until = c.at + NAME_HOLD; continue; }
    if (last && c.at - last.at < 1.2) continue;
    kept.push({ at: c.at, photos: c.photos, until: c.named ? c.at + NAME_HOLD : Infinity });
  }
  const withReleases = [];
  kept.forEach((c, i) => {
    withReleases.push({ at: c.at, photos: c.photos });
    const nextAt = kept[i + 1]?.at ?? Infinity;
    if (c.until < nextAt) withReleases.push({ at: c.until, photos: null });
  });
  return withReleases;
}

/**
 * Render a story short in the v2 look.
 *   chapters  optional [{ cue, photos }]: a countdown's "Number <cue>" starts a
 *             stretch shown only with its own photos (romano-weekly.js)
 */
async function renderStoryV2({ words, audioPath, photos, title, look = 'football', accent = '&H004040FF&', tag = null, label = null, next = null, chapters = [], outputPath, workDir, logger = console }) {
  if (!words?.length) throw new Error('v2 render needs word timings');
  await fsp.mkdir(workDir, { recursive: true });
  const ffmpeg = getFFmpegPath();

  const lastWord = words.at(-1).end;
  const duration = Number((lastWord + 0.6).toFixed(3));
  // Face matching assumes one subject per set, so a countdown's photos are
  // analysed chapter by chapter — five people, five subjects.
  const groups = chapters.length ? [...chapters.map((c) => c.photos), photos.filter((p) => !chapters.some((c) => c.photos.includes(p)))] : [photos];
  // Small photos are sharpened first (Real-ESRGAN, compose_short.py upscale),
  // so the analysis sees the size the render will use.
  try {
    const up = JSON.parse(python(['upscale', ...photos]));
    if (up.upscaled) logger.info?.(`v2: sharpened ${up.upscaled} small photo(s)`);
  } catch (e) { logger.warn?.(`v2: upscale skipped (${String(e.message).slice(0, 80)})`); }
  const metas = Object.assign({}, ...groups.filter((g) => g.length).map((g) => analyzePhotos(g)));
  const ranked = rankPhotos(metas);
  if (!ranked.length) throw new Error('no readable photos');
  const claimed = new Set(chapters.filter((c) => c.names?.length).flatMap((c) => c.photos));
  const resolved = resolveChapters(words, chapters);

  // The hook headline holds through the first sentence, 1.8-3.2s.
  const firstStop = words.find((w) => /[.!?]["'”’]?$/.test(w.word));
  const hookEnd = Math.min(3.2, Math.max(1.8, firstStop ? firstStop.end : 2.4));
  // Moving shots on the words a still cannot carry (utils/broll.js).
  const shots = await addClips(planShots(words, duration, ranked, resolved, claimed.size ? claimed : null), words,
    { look, chapters: resolved, hookEnd, workDir, seed: path.basename(outputPath), logger });
  const stats = statCards(words, hookEnd);
  // The riser builds into the last sentence — or, when the video ends on
  // "Part two is next.", into the teaser just before it.
  const stops = words.map((w, i) => (/[.!?]["'”’]?$/.test(w.word) && i < words.length - 1 ? i : -1)).filter((i) => i >= 0);
  const payoffIdx = stops.at(next ? -2 : -1);
  const payoff = payoffIdx == null ? null : words[payoffIdx + 1].start;
  // The end card lands on the spoken "Part", or the last 1.6s if it is never said.
  let nextCard = null;
  if (next) {
    const k = words.map((w) => bare(w.word)).lastIndexOf('part');
    nextCard = { text: next, at: k >= 0 && k >= words.length - 6 ? words[k].start : Math.max(0, words.at(-1).end - 1.6) };
  }

  const plan = {
    look, duration, shots, ffmpeg,
    accentBgr: bgrOf(accent),
    punches: stats.map((s) => s.t),
    payoff,
    videoOut: path.join(workDir, 'frames.mp4'),
    musicOut: path.join(workDir, 'music.wav'),
    sfxOut: path.join(workDir, 'sfx.wav')
  };
  const planPath = path.join(workDir, 'plan.json');
  await fsp.writeFile(planPath, JSON.stringify(plan, null, 2));
  const assPath = path.join(workDir, 'captions.ass');
  await fsp.writeFile(assPath, buildAss({ words, title, accent, look, hookEnd, stats, tag, label, next: nextCard }));

  logger.info?.(`v2: ${shots.length} shots (${shots.filter((s) => s.video).length} moving) from ${ranked.length} photos, ${stats.length} number card(s), ${duration.toFixed(1)}s`);
  python(['render', planPath]);
  python(['audio', planPath]);

  // Music ducks ~10dB whenever the voice speaks; loudness lands on the -14 LUFS Shorts target.
  const graph = [
    '[1:a]aresample=48000,aformat=channel_layouts=stereo,asplit=2[voice][key]',
    '[2:a]aresample=48000,aformat=channel_layouts=stereo,volume=0.30[mus]',
    '[mus][key]sidechaincompress=threshold=0.025:ratio=7:attack=15:release=400[duck]',
    '[3:a]aresample=48000,aformat=channel_layouts=stereo,volume=0.75[sfx]',
    '[voice][duck][sfx]amix=inputs=3:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]',
    `[0:v]subtitles=filename='${filterPath(assPath)}':fontsdir='${filterPath(FONTS_DIR)}'[v]`
  ].join(';');
  const graphPath = path.join(workDir, 'mix.txt');
  await fsp.writeFile(graphPath, graph);
  await runFFmpeg(['-y', '-i', plan.videoOut, '-i', audioPath, '-i', plan.musicOut, '-i', plan.sfxOut,
    '-filter_complex_script', graphPath, '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '160k', '-t', String(duration), outputPath]);
  return { outputPath, shots, stats, hookEnd, duration };
}

module.exports = { renderStoryV2, planShots, resolveChapters, opener, faceTopInFrame, cutTimes, chunkWords, statCards, rankPhotos, buildAss };
