/**
 * The AI that watches every short before it is posted (asked for on 9 Nov
 * 2026, after the previews showed Madrid's city gates in Antonio Puerta's
 * short, the Thai prime minister holding the World Cup in Robert Enke's and
 * Neymar in Fabrice Muamba's).
 *
 * One frame per photo, cut from the finished video, each sent with the photo's
 * file name and what the narrator says while it is on screen, plus the
 * opening as a hook. A vision model answers which frames do not fit; the
 * caller drops those photos and renders again, or skips the story.
 *
 * Gemini's lite models look first: each has its own free daily quota, so the
 * reviews never eat the script writer's gemini-3.5-flash requests. Mistral's
 * pixtral-12b stands in when they are all out. Returns null when no model
 * answered: the caller then posts as before, on the photo rules alone.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { runFFmpeg } = require('./ffmpeg');

const MAX_FRAMES = 12;

/** One entry per distinct photo or clip: where to cut its frame, what is said over it. */
function framesPlan(shots, words, nameOf = new Map()) {
  const groups = new Map();
  for (const s of shots) {
    const key = s.image;
    const said = words.filter((w) => w.start >= s.start - 0.05 && w.start < s.end).map((w) => w.word).join(' ');
    const g = groups.get(key) || {
      image: key,
      clip: Boolean(s.video),
      at: Math.min(s.end - 0.05, s.start + Math.min(0.9, (s.end - s.start) / 2)),
      name: s.video ? `stock video: ${String(s.pexels || key).split('/').filter(Boolean).pop()}` : (nameOf.get(key) || path.basename(String(key))),
      said: []
    };
    if (said) g.said.push(said);
    groups.set(key, g);
  }
  return [...groups.values()].slice(0, MAX_FRAMES).map((g) => ({ ...g, said: g.said.join(' … ').replace(/\s+/g, ' ').trim() }));
}

async function cutFrame(video, t, out) {
  await runFFmpeg(['-y', '-loglevel', 'error', '-ss', Math.max(0, t).toFixed(2), '-i', video, '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '5', out]);
  return (await fsp.readFile(out)).toString('base64');
}

function prompt({ lane, title, subject, frames, opening }) {
  return `You check a YouTube Short before it is posted on the channel "${lane}".
Title: "${title}". It is about: ${subject}.
The narration opens: "${opening}"

Below are ${frames.length} numbered frames, cut from the finished video in order. For each:
the photo's file name (it says who or what the photo is of) and what the narrator says
while it is on screen.
${frames.map((f, i) => `${i + 1}. file: ${f.name}\n   narrator: "${f.said || '(no words)'}"`).join('\n')}

For EACH frame decide whether the picture fits what is being said at that moment.
OK: it shows the person, team, ground, trophy or event being talked about, or a scene
that plainly belongs to it (that team's fans, that stadium, a memorial for that death,
the story's own era and sport).
BAD: a different sport; a different team, player, referee or person than the one named
(the file name or a kit can show it); a politician or official; a street, gate, church,
shop, office or landmark that has nothing to do with the story; a coin, stamp, poster,
map, document or logo; a cartoon or drawing; a celebrating crowd while a death or
injury is told; anything a viewer would find random or misleading.
You cannot recognise faces: judge by the file name, kits, setting and objects.

Then rate the OPENING (frame 1 and the opening line) 1-10 as a scroll-stopper for a
casual viewer of this channel: a clear face or striking picture in the first second, a
name people know, a concrete shocking fact. 10 = nobody scrolls past.

Return ONLY JSON: {"frames":[{"n":1,"ok":true,"why":"..."}],"hook":{"score":0,"why":"..."}}`;
}

async function askMistral(text, images) {
  if (!process.env.MISTRAL_API_KEY) throw new Error('no MISTRAL_API_KEY');
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey: process.env.MISTRAL_API_KEY, baseURL: 'https://api.mistral.ai/v1', timeout: 90000 });
  let last;
  // pixtral-12b is the vision model the free tier serves (medium and small
  // answered 429, pixtral-large 400 on 9 Nov). It once mixed two frames up,
  // so it only stands in when every Gemini lite model is out.
  for (const model of (process.env.REVIEW_MISTRAL_MODELS || 'pixtral-12b-latest').split(',')) {
    try {
      const r = await client.chat.completions.create({
        model, temperature: 0, max_tokens: 2500, response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: [{ type: 'text', text }, ...images.map((d) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${d}` } }))] }]
      });
      const out = r.choices?.[0]?.message?.content;
      if (out) return { raw: out, model: `mistral/${model}` };
    } catch (e) { last = e; }
  }
  throw last || new Error('Mistral gave no answer');
}

async function askGemini(text, images) {
  if (!process.env.GEMINI_API_KEY) throw new Error('no GEMINI_API_KEY');
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  // Each Gemini model has its own free daily quota: the reviews use the lite
  // models, never the script writer's gemini-3.5-flash. Tested 9 Nov on
  // today's known bad photos (Madrid's gate, a coin, the wrong referee): all
  // three lite models judged 5 of 5 frames right in 3-6s. They refuse a
  // thinkingBudget (400 INVALID_ARGUMENT), so none is sent.
  let last;
  for (const model of (process.env.REVIEW_GEMINI_MODELS || 'gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-flash-lite-latest').split(',')) {
    try {
      const res = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text }, ...images.map((data) => ({ inlineData: { mimeType: 'image/jpeg', data } }))] }],
        config: { temperature: 0, maxOutputTokens: 2500, responseMimeType: 'application/json' }
      });
      const parts = res.candidates?.[0]?.content?.parts || [];
      const raw = parts.filter((p) => !p.thought && p.text).map((p) => p.text).join('').trim() || String(res.text || '');
      if (raw) return { raw, model: `gemini/${model}` };
    } catch (e) { last = e; }
  }
  throw last || new Error('Gemini gave no answer');
}

function parse(raw, n) {
  const m = String(raw).match(/\{[\s\S]*\}/);
  const j = JSON.parse(m ? m[0] : raw);
  const frames = (j.frames || []).map((f) => ({ n: Number(f.n), ok: f.ok !== false && String(f.ok).toLowerCase() !== 'false', why: String(f.why || '') }))
    .filter((f) => f.n >= 1 && f.n <= n);
  if (frames.length < Math.ceil(n / 2)) throw new Error(`answer covered ${frames.length} of ${n} frames`);
  return { frames, hook: { score: Number(j.hook?.score) || 0, why: String(j.hook?.why || '') } };
}

/** Ask the reviewers about prepared frames: [{ name, said, data }] (data = base64 JPEG). */
async function judge({ lane, title, subject, opening, frames, logger = console }) {
  const text = prompt({ lane, title, subject, frames, opening });
  const images = frames.map((f) => f.data);
  for (const ask of (process.env.REVIEW_ORDER === 'mistral' ? [askMistral, askGemini] : [askGemini, askMistral])) {
    try {
      const { raw, model } = await ask(text, images);
      return { ...parse(raw, frames.length), model };
    } catch (e) {
      logger.warn?.(`review: ${ask.name.replace('ask', '')} failed (${String(e.message).slice(0, 120)})`);
    }
  }
  return null;
}

/**
 * Watch a rendered short. shots/words come from the v2 render; nameOf maps a
 * photo path to its Commons title. Returns { bad: [{ image, clip, name, why }],
 * hook, model } or null when no reviewer answered.
 */
async function reviewShort({ video, shots, words, title, subject, lane, nameOf, workDir, logger = console }) {
  const plan = framesPlan(shots, words, nameOf);
  if (!plan.length) return null;
  const dir = workDir || path.join(path.dirname(video), `review-${path.basename(video, '.mp4')}`);
  await fsp.mkdir(dir, { recursive: true });
  try {
    for (const [i, f] of plan.entries()) f.data = await cutFrame(video, f.at, path.join(dir, `f${i + 1}.jpg`));
    const opening = (words.map((w) => w.word).join(' ').match(/^[^.!?]+[.!?]/) || [''])[0];
    const verdict = await judge({ lane, title, subject, opening, frames: plan, logger });
    if (!verdict) return null;
    const bad = verdict.frames.filter((f) => !f.ok).map((f) => ({ image: plan[f.n - 1].image, clip: plan[f.n - 1].clip, name: plan[f.n - 1].name, why: f.why }));
    logger.info?.(`review (${verdict.model}): ${plan.length - bad.length}/${plan.length} frames fit; opening ${verdict.hook.score}/10 (${verdict.hook.why.slice(0, 120)})`);
    for (const b of bad) logger.info?.(`review: does not fit: ${b.name.slice(0, 80)} (${b.why.slice(0, 140)})`);
    return { bad, hook: verdict.hook, model: verdict.model, frames: plan.length };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { reviewShort, judge, framesPlan, prompt };
