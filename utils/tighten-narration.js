/**
 * Narration pacing, from the cut-video skill (Louise de Sadeleer, installed
 * 2026-11-19): tighten a recording by cutting the silences between words,
 * never the words themselves.
 *
 * Edge TTS leaves a pause at every full stop and comma and a little silence
 * before the first word. On a short, those pauses are where a thumb moves on.
 * Each gap longer than `min` is cut down to a short beat (longer after a full
 * stop than after a comma) and the word timings are moved to match, so the
 * captions, cuts and punch-ins built on them stay on their words.
 *
 * The cut is made inside the silence: most of the beat that is kept stays
 * after the word (its release), the rest before the next word (its attack).
 * Edge's own boundaries are exact, so there is no aligner here; the padding
 * covers the ~25ms an MP3 decoder can shift the audio against them.
 */
const { runFFmpeg } = require('./ffmpeg');

const SENTENCE_END = /[.!?]["'”’)]?$/;
const CLAUSE_END = /[,;:—–]["'”’)]?$/;
const r3 = (x) => Number(x.toFixed(3));

/**
 * The stretches of audio to keep, and the words moved onto the shorter clock.
 *   sentence / clause / other   the beat kept after a full stop / a comma / anything else
 *   min                         gaps up to this long are left alone
 *   lead                        silence kept before the first word
 *   tail                        audio kept after the last word
 */
function tightenPlan(words, { sentence = 0.28, clause = 0.15, other = 0.12, min = 0.26, lead = 0.04, tail = 0.45 } = {}) {
  if (!words?.length) return null;
  const keeps = [];
  const removed = [];
  let from = Math.max(0, words[0].start - lead);
  if (from > 0.01) removed.push([0, from]);
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i];
    const b = words[i + 1];
    if (b.start - a.end <= min) continue;
    const beat = SENTENCE_END.test(a.word) ? sentence : CLAUSE_END.test(a.word) ? clause : other;
    const cutStart = a.end + Math.max(0.07, beat * 0.6);
    const cutEnd = b.start - Math.max(0.05, beat * 0.4);
    if (cutEnd - cutStart < 0.04) continue;
    keeps.push([from, cutStart]);
    removed.push([cutStart, cutEnd]);
    from = cutEnd;
  }
  keeps.push([from, words.at(-1).end + tail]);
  const shift = (t) => removed.reduce((s, [c0, c1]) => s + (t >= c1 ? c1 - c0 : t > c0 ? t - c0 : 0), 0);
  return {
    keeps,
    words: words.map((w) => ({ ...w, start: r3(w.start - shift(w.start)), end: r3(w.end - shift(w.end)) })),
    cut: removed.reduce((s, [c0, c1]) => s + (c1 - c0), 0),
    gaps: removed.length
  };
}

/**
 * Write the tightened narration (WAV, so the voice is not encoded twice) and
 * return { audioPath, words, cut, gaps }, or null when under `minCut` seconds
 * would come out.
 */
async function tightenNarration(audioIn, words, { audioOut, minCut = 0.4, ...opts } = {}) {
  const plan = tightenPlan(words, opts);
  if (!plan || plan.cut < minCut) return null;
  const out = audioOut || `${String(audioIn).replace(/\.[^./\\]+$/, '')}_tight.wav`;
  const parts = plan.keeps.map(([a, b], i) => `[0:a]atrim=start=${a.toFixed(3)}:end=${b.toFixed(3)},asetpts=PTS-STARTPTS[k${i}]`);
  const graph = `${parts.join(';')};${plan.keeps.map((_, i) => `[k${i}]`).join('')}concat=n=${plan.keeps.length}:v=0:a=1[out]`;
  await runFFmpeg(['-y', '-loglevel', 'error', '-i', audioIn, '-filter_complex', graph, '-map', '[out]', '-c:a', 'pcm_s16le', out]);
  return { audioPath: out, words: plan.words, cut: plan.cut, gaps: plan.gaps };
}

module.exports = { tightenNarration, tightenPlan };
