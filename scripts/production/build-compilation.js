#!/usr/bin/env node
/**
 * Turn several queued stories into ONE long-form compilation script.
 *
 *   node scripts/build-compilation.js --list
 *   node scripts/build-compilation.js pitch-deaths --dry-run
 *   node scripts/build-compilation.js pitch-deaths
 *
 * Then render it with the pipeline that already exists:
 *
 *   node scripts/produce-longform.js pitch-deaths
 *
 * Why this exists. The channel has been making one video per story, and the
 * measured answer from the niche is that the market wants the opposite. The
 * clearest single data point: Explainer 103% published "The Most Tragic
 * Football Player Deaths" (3.7K views) and "The Tragic Deaths of World Cup
 * Players" (362K) — same channel, same subject, same month. The second names a
 * set people already search for and delivers the whole set in one sitting.
 * "How Every Football Legend Died (part 2)" did 1.9M views on an 8.5K-subscriber
 * channel. One story per video is the format that is not working.
 *
 * So a compilation definition (data/compilations/<id>.json) names a set and
 * lists which queued topics belong to it, ordered weakest-to-strongest so the
 * video builds instead of peaking in the cold open.
 *
 * Every factual sentence still comes from a Wikipedia brief, never from model
 * memory — see utils/research-service.js for why that rule is the product and
 * not a nicety. Every image is Commons-licensed for commercial reuse, and the
 * attribution each one requires is emitted with the script so it can reach the
 * video description, where CC BY actually needs it to be.
 */

require('dotenv').config();

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { AITextService } = require('../../utils/ai-text-service');
const { ResearchService } = require('../../utils/research-service');
const { ArchivalImageService } = require('../../utils/archival-images');
const { Logger } = require('../../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
// DATA_ROOT lets a second channel keep its own queue, compilation definitions
// and rendered scripts, the same way upload-shorts.js already separates their
// upload ledgers — e.g. DATA_ROOT=data/aftercache. Research caches stay shared
// because a Wikipedia brief about Club Penguin is the same brief whoever asks.
const DATA_ROOT = process.env.DATA_ROOT || 'data';
const DEFS_DIR = path.join(ROOT, DATA_ROOT, 'compilations');
const QUEUE_PATH = process.env.QUEUE_PATH || path.join(ROOT, DATA_ROOT, 'queue.json');
const SCRIPTS_DIR = path.join(ROOT, DATA_ROOT, 'scripts');
const BRIEF_CACHE_DIR = path.join(ROOT, 'data', 'research', 'briefs');
const TEXT_CACHE_DIR = path.join(ROOT, 'data', 'research', 'segments');
const logger = new Logger('BuildCompilation');

// Narration on this pipeline's Edge voices runs ~167 words/minute (measured on
// the Kobe documentary: 1439 words -> 8.6 min). Ten to twelve minutes is where
// the competing compilations sit, so this is the per-segment budget that lands
// there without padding.
const WORDS_PER_SEGMENT = 185;
const WORDS_COLD_OPEN = 130;
const WORDS_OUTRO = 90;

// Commons rarely holds more than a handful of genuinely relevant, freely
// licensed files per story; asking for more only lets weaker matches in.
const IMAGES_PER_SEGMENT = 4;

// Below this the cold open would be promising a set the video does not deliver.
const MIN_SEGMENTS = 3;

// Wikipedia answers back-to-back lookups with HTTP 429. Commons gets 1200ms in
// utils/archival-images.js for the same reason; this matches it.
const RESEARCH_DELAY_MS = Number(process.env.RESEARCH_DELAY_MS) || 1500;

async function loadQueue() {
  const raw = JSON.parse(await fsp.readFile(QUEUE_PATH, 'utf8'));
  return new Map((raw.topics || []).map((t) => [t.id, t]));
}

async function listDefinitions() {
  const files = await fsp.readdir(DEFS_DIR).catch(() => []);
  return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
}

/**
 * The first words of a section, used by produce-longform.js to find where the
 * picture should change. It is matched against the real narration word stream,
 * so it has to be words the narrator actually says — hence taking them from the
 * generated text rather than inventing a label.
 */
const cueFrom = (text) => text.trim().split(/\s+/).slice(0, 8).join(' ');

const wordCount = (text) => text.trim().split(/\s+/).filter(Boolean).length;

/**
 * Cut the model's commentary about its own work off the front of the prose.
 *
 * Asked for narration and nothing else, one segment came back opening with
 * "...avoided any post-event tributes, honours, or statistics, staying within
 * the 170-200 word range. Narration (~152 words) Abdelhak Nouri, a young..."
 * — and the narrator read every word of that aloud in the finished video. The
 * real script always starts after such a marker, so when one is present
 * everything before it goes.
 */
function stripMetaPreamble(text) {
  const marker = /(?:^|[\s.])(?:narration|script|text)\s*(?:\([^)]*\))?\s*[:\-—]?\s+(?=[A-Z"'])/;
  const hit = marker.exec(text);
  if (hit && hit.index < text.length * 0.5) return text.slice(hit.index + hit[0].length).trim();
  return text;
}

/** Phrases that only appear when the model is describing its own compliance. */
const META_TELLS = new RegExp([
  'word (?:range|count|limit)',
  'as (?:requested|instructed)',
  'per the (?:rules|instructions)',
  'I (?:avoided|kept|stayed|wrote|have written)',
  'the instructions?(?: above| say)',
  'this (?:compilation|video|documentary|film)'
].join('|'), 'i');

/** Strip the scaffolding a chat model wraps around prose however it is asked. */
function cleanProse(raw) {
  const text = stripMetaPreamble(String(raw || ''))
    .replace(/^\s*```[a-z]*\s*|\s*```\s*$/gi, '')
    .replace(/^\s*here(?:'s| is)[^\n.]*[.:]\s*/i, '')
    .replace(/^\s*(?:segment|section|narration|script)\s*\d*\s*[:\-—]\s*/i, '')
    .replace(/^#+\s.*$/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // A response cut off at the token cap ends mid-sentence, and the narrator
  // will read that fragment aloud exactly as written ("...for every future
  // generation to."). Drop a trailing incomplete sentence rather than ship it.
  let out = text;
  if (!/[.!?]["']?$/.test(out)) {
    const lastStop = Math.max(out.lastIndexOf('.'), out.lastIndexOf('!'), out.lastIndexOf('?'));
    if (lastStop > out.length * 0.5) out = out.slice(0, lastStop + 1);
  }

  // A truncated tail can still carry a full stop and read as a sentence to the
  // regex above while being nonsense aloud — one draft ended "...reshaped
  // medical response in the sport. for future." Anything under four words at
  // the end is that, not a sentence.
  const sentences = out.match(/[^.!?]+[.!?]+/g) || [];
  if (sentences.length > 1 && wordCount(sentences[sentences.length - 1]) < 4) {
    out = sentences.slice(0, -1).join('').trim();
  }
  return out;
}

/**
 * One segment of the compilation. The brief is passed as the ONLY permitted
 * source of names, dates and numbers; the model's job here is ordering and
 * rhythm, not recall.
 */
async function writeSegment(ai, { topic, angle, brief, position, total }) {
  const prompt = `You are writing one segment of a documentary compilation narration.

SEGMENT ${position} OF ${total}. Subject: ${topic}

The angle to take: ${angle}

SOURCE MATERIAL — the only place you may take names, dates, numbers, places and
outcomes from. If a detail is not here, it does not go in:
"""
${brief}
"""

Write ${WORDS_PER_SEGMENT} words of narration, give or take fifteen.

Rules:
- Name the person or event in the first sentence. The viewer is arriving
  mid-video and needs to know instantly whose story this is.
- Tell it in the order it happened. Never put the aftermath before the event.
- This is narration, not an encyclopedia entry. Do NOT recite career statistics,
  cap counts, goal tallies, transfer histories or lists of former clubs. A
  biographical detail earns its place only if it changes how the event lands.
- End at the event itself or its immediate consequence. Do not trail off into
  honours, retired shirt numbers, statues or posthumous decorations.
- Past tense, plain declarative sentences. No rhetorical questions.
- No second person. Never "you". No "imagine", no "picture this".
- Do not number the segment or write any heading. Prose only.
- Do not address the audience, ask for likes, or mention the channel.
- If the source material does not support a detail, leave it out rather than
  reaching for it.
- Finish your final sentence completely.

Return the narration text and nothing else.`;

  // produce-longform.js gives each section screen time in proportion to how
  // long its narration runs, so a segment at double the word budget runs at
  // double the length on the same four images — a two-minute near-still in the
  // middle of the video. One retry is cheaper than that.
  let text = cleanProse(await ai.generateText(prompt, { maxTokens: 900, temperature: 0.7 }));
  if (wordCount(text) > WORDS_PER_SEGMENT * 1.6) {
    logger.warn(`"${topic}" came back at ${wordCount(text)} words against a ${WORDS_PER_SEGMENT} target; retrying tighter.`);
    const retry = cleanProse(await ai.generateText(
      `${prompt}

Your previous attempt ran far too long. Stay under ${WORDS_PER_SEGMENT + 15} words.`,
      { maxTokens: 640, temperature: 0.6 }
    ));
    if (wordCount(retry) >= WORDS_PER_SEGMENT * 0.4 && wordCount(retry) < wordCount(text)) text = retry;
  }
  // The narrator reads whatever is here, so meta-commentary that survived
  // stripping has to be regenerated rather than shipped. This is not
  // hypothetical: one render narrated "staying within the 170-200 word range"
  // aloud in the middle of a documentary.
  if (META_TELLS.test(text)) {
    logger.warn(`"${topic}" came back describing its own compliance; regenerating.`);
    const retry = cleanProse(await ai.generateText(
      `${prompt}\n\nReturn ONLY the narration itself. Do not describe what you did or did not include.`,
      { maxTokens: 900, temperature: 0.6 }
    ));
    if (!META_TELLS.test(retry) && wordCount(retry) >= WORDS_PER_SEGMENT * 0.4) text = retry;
    else logger.warn(`"${topic}" still contains meta-commentary — check it by hand before rendering.`);
  }

  if (wordCount(text) < WORDS_PER_SEGMENT * 0.4) {
    throw new Error(`segment for "${topic}" came back too short (${wordCount(text)} words)`);
  }
  return text;
}

/**
 * Every figure the narration states should be traceable to the brief it was
 * written from. This does not block the build — a legitimate number can be
 * spelled differently than its source spells it — but on a channel whose whole
 * premise is sourced accuracy, an unflagged invented number is the worst thing
 * that can ship, so each one gets named.
 */
function flagUnsourcedNumbers(sectionId, text, briefText) {
  // Strip thousands separators on both sides. Without this the check reported
  // "53,000" as unsourced against a brief that plainly said "53000" — a false
  // alarm that trains you to ignore the real ones.
  const fold = (t) => t.normalize('NFKD').replace(/[‐-―−]/g, '-').replace(/,/g, '').toLowerCase();
  const source = fold(briefText);
  const numbers = [...new Set(fold(text).match(/\d[\d,.:]*/g) || [])]
    .map((x) => x.replace(/[.,:]+$/, ''))
    .filter((x) => x.length > 1);

  const missing = numbers.filter((x) => !source.includes(x));
  if (missing.length) {
    logger.warn(`${sectionId}: ${missing.join(', ')} appear in the narration but not in the source — verify before upload.`);
  }
  return missing;
}

/**
 * The cold open has one job: promise the whole set so the viewer stays for all
 * of it.
 *
 * It is also the single most dangerous paragraph in the video. Given only a
 * list of titles it will flatten them into one outcome — the first draft of
 * this compilation opened by calling all seven collapses fatal, when Muamba and
 * Eriksen both survived. So each story arrives here with its own angle attached,
 * and the prompt is told in as many words not to assume they ended alike.
 */
async function writeColdOpen(ai, def, prepared) {
  // The opening line is the one place this pipeline invented a fact. Asked for
  // "one concrete, specific image" while being handed nothing but titles, the
  // model supplied its own: "At 17:45 on a rainy April afternoon" — a clock
  // time and a weather report that appear nowhere in any source. A prompt that
  // demands specifics has to supply them, so the first story's brief comes too.
  const opener = prepared[0];
  const lines = prepared
    .map((p, i) => `${i + 1}. ${p.entry.topic}`
      + `\n   outcome: ${p.entry.outcome || 'see angle'}`
      + `\n   angle: ${p.entry.angle || '(see title)'}`)
    .join('\n');

  // Counting is done here, not by the model. Asked to work it out from prose it
  // said "three lives ended on the field" about a set where four people died.
  const died = prepared.filter((p) => /died|killed|fatal/i.test(p.entry.outcome || '')).length;
  const survived = prepared.length - died;
  const tally = prepared.every((p) => p.entry.outcome)
    ? `Of the ${prepared.length}, exactly ${died} died and exactly ${survived} survived. `
      + 'Use these numbers if you state any count. Do not compute your own.'
    : 'Do not state how many died or survived — the outcomes are not all recorded here.';

  const prompt = `You are writing the cold open of a documentary compilation titled "${def.title}".

The video covers these ${prepared.length} stories, in this order:
${lines}

SOURCE MATERIAL for the opening story (${opener.entry.topic}). Any concrete
detail in your first sentence must come from here and nowhere else:
"""
${opener.brief.text.slice(0, 2500)}
"""

Write ${WORDS_COLD_OPEN} words of narration to open the video.

${tally}

Rules:
- Read the outcome of every story before writing a single word. They did NOT all
  end the same way. Any sentence describing the whole set as having died is
  factually wrong and unusable.
- If the outcomes differ, that difference is the hook. Say so.
- Start with one concrete, specific fact taken from the source material above —
  not a generalisation about football or about death.
- Invent NOTHING. Do not state a time of day, the weather, a crowd size, a
  shirt colour, a minute of play or anyone's words unless the source says so.
  If the source does not give you a vivid detail, use a plain sourced one.
- Make clear the video covers all ${prepared.length} of these, so the viewer
  knows what they are staying for.
- Do not list them by name. Say what they have in common.
- Never refer to "the film", "this video", "this compilation", "these stories"
  or the channel. The narration does not describe itself.
- Do not end with a sentence about why it matters or who was watching.
- Past tense, plain declarative sentences. No second person, never "you".
- No questions. No "imagine". No subscribe request.
- Prose only, no heading. Finish your final sentence completely.

Return the narration text and nothing else.`;

  return cleanProse(await ai.generateText(prompt, { maxTokens: 700, temperature: 0.7 }));
}

async function writeOutro(ai, def, prepared) {
  const covered = prepared
    .map((p) => `${p.entry.topic} — ${p.entry.outcome || 'outcome not recorded'}`)
    .join('\n');

  const prompt = `Write the closing ${WORDS_OUTRO} words of a documentary compilation titled "${def.title}".

It covered:
${covered}

Rules:
- The outcomes above differ. Do not write a closing line that applies one
  outcome to all of them — "and that risk ultimately claimed them" is false for
  anyone who survived, and a false final sentence is the one viewers remember.
- Draw the thread between them in a way the individual stories did not.
- Say something specific. Avoid the register of a press release: no "shared
  resolve", no "catalysts for change", no "true foundation of competition".
- Past tense, plain declarative sentences. No second person.
- Do not recap them one by one. Do not ask for likes, comments or subscriptions.
- End on a statement, not a question, and finish the sentence completely.
- Prose only, no heading.

Return the narration text and nothing else.`;

  return cleanProse(await ai.generateText(prompt, { maxTokens: 800, temperature: 0.7 }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Keep each segment's narration on disk once it is written.
 *
 * Every provider in the chain rate-limits or drops out intermittently, and a
 * single failed call was throwing away every segment generated before it —
 * twice, seven and four segments deep. The cache is keyed on the brief the
 * segment was written from, so re-running resumes rather than re-rolling, and
 * changing the source still forces a rewrite.
 */
async function cachedSegment(compilationId, segmentId, briefText, generate) {
  const key = crypto.createHash('sha1').update(briefText).digest('hex').slice(0, 10);
  const file = path.join(TEXT_CACHE_DIR, `${compilationId}_${segmentId}_${key}.txt`);

  const kept = await fsp.readFile(file, 'utf8').catch(() => null);
  if (kept && kept.trim()) return { text: kept.trim(), fromCache: true };

  const text = await generate();
  await fsp.mkdir(TEXT_CACHE_DIR, { recursive: true });
  await fsp.writeFile(file, text);
  return { text, fromCache: false };
}

/**
 * Find the Wikipedia brief for one queued story.
 *
 * Two things had to be handled here that the shared ResearchService cannot know
 * about. First, a queue topic is a narrative sentence ("The death of Miklos
 * Feher"), and findArticle requires every one of its terms to appear in the
 * article lead — "death" never does, so the correct article is rejected. The
 * entry's own keywords[0] is the clean subject name, so it is tried first and
 * the sentence only as a fallback.
 *
 * Second, Wikipedia answers a burst of back-to-back lookups with HTTP 429. That
 * surfaced as segments silently dropping out of the compilation, which is a far
 * worse failure than being slow — so calls are spaced and a rate-limited lookup
 * is retried rather than treated as "no such article".
 */
async function briefFor(research, entry, { attempt = 1 } = {}) {
  // Wikipedia's 429 is intermittent: across two identical runs it dropped a
  // different pair of segments each time. Retrying alone therefore cannot make
  // a run deterministic, but caching can — every brief that lands is kept, so
  // re-running fills the remaining gaps instead of re-rolling the whole set.
  const cachePath = path.join(BRIEF_CACHE_DIR, `${entry.id}.json`);
  const cached = await fsp.readFile(cachePath, 'utf8').then(JSON.parse).catch(() => null);
  if (cached?.text) {
    logger.info(`${entry.id}: brief from cache ("${cached.title}")`);
    return cached;
  }

  // A planned entry names its verified article (plan-compilation.js). The brief
  // cache does not survive between cloud runs, and searching the topic
  // sentence instead can land on a different article entirely.
  if (entry.article) {
    const pinned = await research.buildBriefFromArticle(entry.article).catch(() => null);
    if (pinned) {
      await fsp.mkdir(BRIEF_CACHE_DIR, { recursive: true });
      await fsp.writeFile(cachePath, JSON.stringify(pinned, null, 2));
      return pinned;
    }
  }

  const keywords = (entry.keywords || []).map(String).filter(Boolean);

  // Order matters more than anything else here. Searching keywords[0] first
  // looked like the fix for topic sentences that would not match ("The death
  // of Miklos Feher"), but keywords[0] is the VENUE — so "Ibrox" returned the
  // article about Ibrox Stadium rather than the 1971 disaster, "Port Said"
  // returned the city, "Bradford City" the football club. Six of eight
  // stadium-disaster segments were written from an article that never
  // mentioned the disaster, and the narration filled the gap from model
  // memory: the Ibrox brief contains no mention of stairs, yet the script
  // named Stairway 13 and two earlier crushes.
  //
  // So the event word from the topic is carried into the query, and the bare
  // venue name is only ever the last resort.
  const eventWord = (/(disaster|fire|crush|collapse|crash|riot|stampede|scandal|ruling|murder)/i
    .exec(entry.topic || '') || [])[1];

  const candidates = [
    entry.topic,
    eventWord && keywords[0] ? `${keywords[0]} ${eventWord}` : null,
    keywords.slice(0, 2).join(' '),
    keywords[0]
  ].filter((c, i, all) => c && all.indexOf(c) === i);

  for (const candidate of candidates) {
    const brief = await research.buildBrief(candidate);
    if (brief) {
      // An article titled for the venue when the topic is an event is the
      // signature of the bug above; say so rather than let it pass silently.
      if (eventWord && !new RegExp(eventWord, 'i').test(brief.title)) {
        logger.warn(`${entry.id}: matched "${brief.title}", which is not about the ${eventWord} `
          + '— the narration may not be fully sourced. Verify before publishing.');
      }
      await fsp.mkdir(BRIEF_CACHE_DIR, { recursive: true });
      await fsp.writeFile(cachePath, JSON.stringify(brief, null, 2));
      return brief;
    }
    await sleep(RESEARCH_DELAY_MS);
  }

  if (attempt < 3) {
    // Every candidate failing at once is the signature of rate limiting rather
    // than of a genuinely missing article, so back off and try the set again.
    const wait = RESEARCH_DELAY_MS * 10 * attempt;
    logger.warn(`No brief for "${entry.id}" on attempt ${attempt}; backing off ${(wait / 1000).toFixed(0)}s`);
    await sleep(wait);
    return briefFor(research, entry, { attempt: attempt + 1 });
  }
  return null;
}

/**
 * Commons images for one story. Queries go specific-first: the full keyword
 * phrase, then narrower pairs, because a surname alone pulls in unrelated
 * namesakes and a venue alone pulls in tourist photos.
 */
async function imagesFor(archival, topicEntry, destDir) {
  // Commons is as intermittent as Wikipedia: the same story returned four
  // usable files on one run and zero on the next, which silently dropped a
  // segment that had already been researched and downloaded. The files are
  // still on disk, so a manifest makes a hiccup cost nothing.
  const manifestPath = path.join(destDir, '_manifest.json');
  const manifest = await fsp.readFile(manifestPath, 'utf8').then(JSON.parse).catch(() => ({}));

  // Keep the BEST result ever seen, not the latest. Commons returned four
  // usable files for one story on one run and a single file on the next, and a
  // last-write-wins manifest happily replaced the good set with the poor one,
  // so reruns got worse instead of converging.
  const remember = async (result) => {
    const kept = manifest[topicEntry.id];
    if (kept?.files?.length >= result.files.length) {
      logger.info(`${topicEntry.id}: keeping the earlier, richer set of ${kept.files.length} image(s).`);
      return kept;
    }
    manifest[topicEntry.id] = result;
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    return result;
  };
  const fallback = async () => {
    const kept = manifest[topicEntry.id];
    if (kept?.files?.length) {
      logger.warn(`${topicEntry.id}: Commons returned nothing; reusing ${kept.files.length} already-downloaded image(s).`);
      return kept;
    }
    return { files: [], credits: [] };
  };

  const keywords = (topicEntry.keywords || []).map(String).filter(Boolean);
  if (!keywords.length) return fallback();

  const queries = [
    keywords.slice(0, 3).join(' '),
    keywords.slice(0, 2).join(' '),
    keywords[0]
  ].filter((q, i, all) => q && all.indexOf(q) === i);

  // `must` is what makes a file genuinely ABOUT this story, and only the
  // subject qualifies. Building it from every keyword put "Sevilla" — a city —
  // in the required set, so a photo of a Seville street passed the relevance
  // check and three of them ended up in the published Puerta segment. The
  // subject is keywords[0]; everything else is context and belongs in `bonus`,
  // where it can only break ties between files that already qualify.
  // Only the FULL subject phrase qualifies, never its individual words.
  // Allowing single tokens was not enough of a tightening: "Emiliano Sala"
  // let through three photographs of Uffizi gallery rooms, because "sala" is
  // Italian for room and the captions happened to say "emiliano romagnolo".
  // "Charkhi Dadri" likewise matched a district water department and a
  // secondary school. Requiring the whole phrase costs some recall and buys
  // back the thing that actually matters, which is that the picture is of the
  // subject.
  const subject = (keywords[0] || '').trim();
  const must = subject ? [subject] : [];

  const selectors = { must, bonus: keywords.slice(1) };

  const found = await archival.gatherForTopic(queries, selectors, {
    perQuery: 8,
    total: IMAGES_PER_SEGMENT
  }).catch(() => []);
  if (!found.length) return fallback();

  const saved = await archival.downloadArchivalImages(found, destDir);
  const files = saved
    .map((s) => (typeof s === 'string' ? s : s.path || s.filePath))
    .filter(Boolean)
    .map((p) => path.basename(p));

  if (!files.length) return fallback();

  return remember({
    files,
    credits: found.map((f) => ({
      file: f.title,
      // The service calls this field `artist`; reading `author` silently
      // credited every CC BY image to "unknown", which does not satisfy the
      // licence its use depends on.
      license: f.license || 'unknown',
      author: f.artist || f.credit || 'unknown',
      source: f.descriptionUrl || f.url
    }))
  });
}

async function build(id, { dryRun }) {
  const def = JSON.parse(await fsp.readFile(path.join(DEFS_DIR, `${id}.json`), 'utf8'));
  const queue = await loadQueue();

  // A segment is either a bare queue id or { id, outcome }. The outcome is
  // stated by hand rather than inferred because the model got it wrong twice:
  // it opened the video claiming all seven players died when three survived,
  // and then miscounted the dead as three when there were four. Counting and
  // characterising outcomes from prose is not something to delegate.
  const entries = def.segments.map((seg) => {
    const segId = typeof seg === 'string' ? seg : seg.id;
    const entry = queue.get(segId);
    if (!entry) throw new Error(`"${segId}" is listed in ${id}.json but not in data/queue.json`);
    return { ...entry, outcome: typeof seg === 'string' ? null : seg.outcome || null };
  });

  logger.info(`${def.title} — ${entries.length} segments`);
  const estWords = WORDS_COLD_OPEN + entries.length * WORDS_PER_SEGMENT + WORDS_OUTRO;
  logger.info(`Target ~${estWords} words ≈ ${(estWords / 167).toFixed(1)} min narrated.`);

  if (dryRun) {
    entries.forEach((e, i) => console.log(`  ${String(i + 1).padStart(2)}. ${e.id.padEnd(14)} ${e.topic}`));
    logger.info('Dry run — nothing written.');
    return;
  }

  const ai = new AITextService({});
  const research = new ResearchService();
  const archival = new ArchivalImageService();
  const imgDir = path.join(ROOT, DATA_ROOT, 'reference', `${id}-archival`);
  await fsp.mkdir(imgDir, { recursive: true });

  // Research and images first. A segment whose facts or pictures cannot be
  // sourced has to drop out of the running order BEFORE the cold open promises
  // it — otherwise the video opens by announcing a set it never delivers.
  const prepared = [];
  for (const entry of entries) {
    const brief = await briefFor(research, entry);
    // A Wikipedia stub cannot source a 185-word segment. Two of them slipped
    // through at 161 and 400 characters, and the narration written from them
    // was therefore mostly the model's own recall — exactly what this pipeline
    // exists to prevent.
    if (brief && brief.text.length < 1200) {
      logger.warn(`"${entry.id}": brief is only ${brief.text.length} chars — too thin to source a segment; skipping.`);
      continue;
    }
    if (!brief) {
      logger.warn(`Skipping "${entry.id}" — no research brief, and unsourced narration is not shippable.`);
      continue;
    }
    const { files, credits } = await imagesFor(archival, entry, imgDir);
    if (!files.length) {
      logger.warn(`Skipping "${entry.id}" — no freely licensed images found.`);
      continue;
    }
    if (files.length < 2) {
      // produce-longform.js splits a section's running time evenly across its
      // images, so one image means one motionless still for the whole segment.
      logger.warn(`"${entry.id}" found only ${files.length} image — that segment will hold a single still.`);
    }
    logger.info(`${entry.id}: brief "${brief.title}" + ${files.length} image(s)`);
    prepared.push({ entry, brief, files, credits });
  }

  if (prepared.length < MIN_SEGMENTS) {
    throw new Error(`Only ${prepared.length} segment(s) survived sourcing — that is a clip, not a compilation.`);
  }
  if (prepared.length < entries.length) {
    logger.warn(`${entries.length - prepared.length} segment(s) dropped; the video covers ${prepared.length}.`);
  }

  const sections = [];
  const attribution = [];

  const coldOpen = await writeColdOpen(ai, def, prepared);
  flagUnsourcedNumbers('cold-open', coldOpen, prepared.map((p) => p.brief.text).join(' '));
  sections.push({
    id: 'cold-open',
    title: def.title,
    images: prepared[0].files.slice(0, 2),
    text: coldOpen,
    cueText: cueFrom(coldOpen)
  });

  for (const [i, p] of prepared.entries()) {
    const { text, fromCache } = await cachedSegment(id, p.entry.id, p.brief.text, () => writeSegment(ai, {
      topic: p.entry.topic,
      angle: p.entry.angle || p.entry.topic,
      brief: p.brief.text,
      position: i + 1,
      total: prepared.length
    }));
    sections.push({
      id: p.entry.id,
      title: p.entry.topic,
      images: p.files,
      text,
      cueText: cueFrom(text),
      source: p.brief.url
    });
    attribution.push(...p.credits);
    const unsourced = flagUnsourcedNumbers(p.entry.id, text, p.brief.text);
    logger.info(`[${i + 1}/${prepared.length}] ${p.entry.id}: ${wordCount(text)} words`
      + (fromCache ? ' (kept from an earlier run)' : '')
      + (unsourced.length ? ` (${unsourced.length} figure(s) to verify)` : ''));
  }

  const outro = await writeOutro(ai, def, prepared);
  sections.push({
    id: 'outro',
    title: 'Closing',
    images: prepared[prepared.length - 1].files.slice(0, 2),
    text: outro,
    cueText: cueFrom(outro)
  });

  const doc = {
    title: def.title,
    angle: def.hook || def.title,
    keywords: [...new Set(prepared.flatMap((p) => p.entry.keywords || []))].slice(0, 12),
    sections,
    attribution,
    sources: prepared.map((p) => ({ id: p.entry.id, article: p.brief.title, url: p.brief.url }))
  };

  await fsp.mkdir(SCRIPTS_DIR, { recursive: true });
  const outPath = path.join(SCRIPTS_DIR, `longform_${id}.json`);
  await fsp.writeFile(outPath, JSON.stringify(doc, null, 2));

  const words = sections.reduce((a, s) => a + wordCount(s.text), 0);
  logger.success(`${id}: ${sections.length} sections, ${words} words (~${(words / 167).toFixed(1)} min) -> ${outPath}`);
  logger.info(`Images: ${imgDir}`);
  logger.info(`Render it: node scripts/produce-longform.js ${id}`);
  logger.info(`${attribution.length} image credit(s) belong in the description — they are in the script's "attribution".`);
}

async function showList() {
  const defs = await listDefinitions();
  const queue = await loadQueue();

  console.log('\n  Compilations defined in data/compilations/\n');
  if (!defs.length) {
    console.log('  (none yet)\n');
    return;
  }
  for (const d of defs) {
    const def = JSON.parse(await fsp.readFile(path.join(DEFS_DIR, `${d}.json`), 'utf8'));
    // Segments are either a bare id or { id, outcome }; this listing predated
    // the second shape and printed "[object Object]" for every one of them.
    const missing = def.segments
      .map((seg) => (typeof seg === 'string' ? seg : seg.id))
      .filter((id) => !queue.has(id));
    console.log(`  ${d.padEnd(20)} ${String(def.segments.length).padStart(2)} segments   ${def.title}`);
    if (missing.length) console.log(`  ${''.padEnd(20)} !! not in queue: ${missing.join(', ')}`);
  }
  console.log('\n  node scripts/build-compilation.js <id> [--dry-run]\n');
}

async function main() {
  const args = process.argv.slice(2);
  const id = args.find((a) => !a.startsWith('--'));

  if (!id) {
    await showList();
    return;
  }
  await build(id, { dryRun: args.includes('--dry-run') });
}

if (require.main === module) {
  main().catch((error) => {
    logger.error(`build-compilation failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { build };
