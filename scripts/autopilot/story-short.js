#!/usr/bin/env node
/**
 * A 20-50s story short about one dramatic, documented moment (each lane's
 * story.words sets the length).
 *
 *   node scripts/autopilot/story-short.js "Football Files"            # make one
 *   node scripts/autopilot/story-short.js "Football Files" --dry-run  # pick + write, render nothing
 *   node scripts/autopilot/story-short.js "Football Files" --sequel <story id> --dry-run   # its next part
 *   node scripts/autopilot/story-short.js "Football Files" --article "Harry Kane" \
 *     --moment "On 26 October 2026 Kane won the Ballon d'Or." --title "Why Harry Kane Won the Ballon d'Or"
 *   node scripts/autopilot/story-short.js "Football Files" --series --dry-run  # the planned series part due (series.js)
 *
 * Why this format. Measured 2026-10-07 across ~2,000 recent videos in 30
 * niches: the fastest-growing young football channel, GOATED90 (created
 * Nov 2025, 130K subs, 351M views), posts one story every day or two, every
 * one 2:30-3:00 long, every one about a FAMOUS name at a dramatic turn —
 * "When Balotelli Completely Lost His Mind 😭🔥" 4.4M, "The Ronaldo Comeback
 * Nobody Was Ready For" 2.0M, "The Man Who DESTROYED the Galácticos 💀" 1.1M.
 * PureGrit (NFL, 154K subs) is the same shape at 45-60s. This channel had been
 * making the opposite: 45s shorts about obscure subjects (Scarborough F.C.).
 *
 * What stays from this repo's rules: every fact comes from the Wikipedia
 * article the story is verified against, never from model memory, and every
 * picture is a Commons photo of the subject, credited in the description.
 */

require('dotenv').config();

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const axios = require('axios');
const { AITextService } = require('../../utils/ai-text-service');
const { ResearchService } = require('../../utils/research-service');
const { ArchivalImageService } = require('../../utils/archival-images');
const { ShortsFactory } = require('../../utils/shorts-factory');
const { Logger } = require('../../utils/logger');
const { LANES } = require('./lanes');
const { footballNews } = require('../../utils/news-feed');
const { renderStoryV2 } = require('../../utils/short-style-v2');
const { teamTheme } = require('../../utils/broll');
const { SERIES, seriesPartDue, partId, NUMBER_WORDS } = require('./series');

const ROOT = path.join(__dirname, '..', '..');
const logger = new Logger('StoryShort');

// ~1:50-2:55 at Edge TTS pace; a lane can set its own via story.words.
const DEFAULT_WORDS = { min: 250, target: 360, max: 420 };
// A cut every ~3.5s: at 20-50s, 6s holds left a short with four slow stills.
const SECONDS_PER_IMAGE = 3.5;

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const slug = (s, max = 30) => fold(s).replace(/\([^)]*\)/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, max).replace(/-$/, '');
const words = (t) => String(t).trim().split(/\s+/).filter(Boolean).length;
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return fb; } };

function parseJson(raw) {
  const text = String(raw || '').replace(/```(?:json)?/gi, '');
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s === -1 || e <= s) throw new Error('no JSON in reply');
  return JSON.parse(text.slice(s, e + 1));
}

// What each lane's stories are about. A lane without its own `story` block in
// lanes.js gets the football brief, which is where this format was measured.
const DEFAULT_STORY = {
  examples: [
    'When Balotelli Completely Lost His Mind 😭🔥  (4.4M)',
    'The Ronaldo Comeback Nobody Was Ready For 😭🔥  (2.0M)',
    'How Did Ronaldo Even Do This 😭🔥  (1.5M)',
    'Football Gave Torres the SAME Chance Twice  (1.2M)',
    'The Man Who DESTROYED the Galácticos 💀  (1.1M)',
    'The Champions League Run That Made ZERO Sense 😭🔥  (1.0M)',
    'When Karma DESTROYED an Entire National Team 😭🔥  (0.7M)'
  ],
  scope: 'About a FAMOUS footballer, manager, club or national team that casual fans\n'
    + '  worldwide know. Not obscure lower-league subjects.\n'
    + '- One specific, dramatic episode with an arc: meltdown, betrayal, impossible\n'
    + '  comeback, karma, redemption, rivalry turning into war, a season that made no\n'
    + '  sense, a career that collapsed, a disappearance.',
  captionExample: 'Mario Balotelli',
  tags: ['football', 'football story']
};

/**
 * What the world looked up on Wikipedia yesterday — the cheapest honest signal
 * of what people care about today. A story about a name people are already
 * searching gets pushed by search and the Shorts feed's freshness; a 1995
 * Cantona story competes with everything. Never fatal: [] on any failure.
 */
async function trending(limit = 150) {
  const d = new Date(Date.now() - 86400000);
  const ymd = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
  try {
    const { data: json } = await axios.get(`https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${ymd}`, {
      headers: { 'User-Agent': 'youtube-automation-engine/1.0 (autopilot trending check)' },
      timeout: 15000
    });
    return (json.items?.[0]?.articles || [])
      .map((a) => a.article.replace(/_/g, ' '))
      .filter((t) => !/^(Main Page|Special:|Wikipedia:|Portal:|File:|Help:|Talk:|Category:|Template:|Deaths in |List of |\d{4} in )/.test(t))
      .slice(0, limit);
  } catch {
    return [];
  }
}


const STAR_STRATEGY = `
STRATEGY (what pulled 2-40 million views on football Shorts in late October
2026): at least HALF of your proposals must be about today's biggest stars —
Lamine Yamal, Kylian Mbappé, Erling Haaland, Harry Kane, Vinícius Júnior, Jude
Bellingham, Mohamed Salah, Cristiano Ronaldo, Lionel Messi, Neymar — or about
this week's big event (a final, El Clásico, the Ballon d'Or, a record, a
transfer). A story from IN THE NEWS above beats everything else.
For a current star the moment does NOT have to be dark: a record, a heartbreak,
a final won or lost, a red card, a comeback, a meltdown — but it MUST be one
their English Wikipedia article already tells (the 7 Nov test invented a Salah
collapse and a Messi ban; every one was rejected). If you are not sure an
episode is in the article, pick a different one.`;

// The stars the strategy leans on, and real lines about them: told only "use
// real moments", the model still invented injuries and bans (7 Nov tests, all
// rejected). Given their own article text, it picks from what is there.
const STARS = ['Lamine Yamal', 'Kylian Mbappé', 'Erling Haaland', 'Harry Kane', 'Vinícius Júnior', 'Jude Bellingham',
  'Mohamed Salah', 'Cristiano Ronaldo', 'Lionel Messi', 'Neymar'];
const BIG_MOMENT = /record|youngest|oldest|first (player|time)|final|hat-trick|hat trick|scored|won the|winner|red card|sent off|ban|injur|ballon d|golden boot|world cup|champions league|euro|transfer|fee|debut|missed|penalt|controvers|tears|lost/i;
async function starFactItems(research, n = 3) {
  const day = Math.floor(Date.now() / 86400000);
  const pick = Array.from({ length: n }, (_, i) => STARS[(day * n + i) % STARS.length]);
  const out = [];
  for (const star of pick) {
    const full = await research.buildBriefFromArticle(star, { maxChars: 150000 }).catch(() => null);
    if (!full?.text) continue;
    const lines = (full.text.match(/[^.!?\n]+[.!?]/g) || [])
      .map((x) => x.trim()).filter((x) => x.length > 50 && x.length < 320 && BIG_MOMENT.test(x) && /\b(19|20)\d\d\b/.test(x));
    if (lines.length) out.push({ star, article: full.title || star, lines: lines.slice(0, 10) });
  }
  return out;
}
const factsText = (items) => items.map((it) => `${it.star} (article: "${it.article}"):\n${it.lines.map((l) => `  - ${l}`).join('\n')}`).join('\n');

/**
 * Star stories made straight from those lines: the moment IS a sentence of the
 * star's own article, so it cannot be invented (the model kept proposing bans
 * and collapses that never happened, 8 Nov). The model only writes the titles.
 */
async function factStories(ai, items, max = 6) {
  const cands = items.flatMap((it) => it.lines.slice(0, 3).map((line) => ({ article: it.article, subject: it.star, moment: line })))
    .slice(0, max);
  if (!cands.length) return [];
  const prompt = `For each real football moment below, write a YouTube Shorts title: under 55
characters, opening on the player's name, stating what happened plainly as a
fact (no question), ending with ONE fitting emoji. Use only what the line says.
${cands.map((c, i) => `${i + 1}. ${c.moment}`).join('\n')}
Return ONLY JSON: {"titles": ["...", "..."]}`;
  try {
    const titles = parseJson(await ai.generateText(prompt, { maxTokens: 900, temperature: 0.4 })).titles || [];
    return cands.map((c, i) => ({ ...c, title: String(titles[i] || '').trim() })).filter((c) => c.title.length >= 10);
  } catch {
    return [];
  }
}

async function propose(ai, lane, avoid, hot = [], news = [], facts = '') {
  const story = lane.story || DEFAULT_STORY;
  const prompt = `You pick stories for the YouTube Shorts channel "${lane.name}".

The format that is winning right now (titles and views from young channels):
${story.examples.map((e) => `- ${e}`).join('\n')}
${news.length ? `
IN THE NEWS — this channel's headlines from the last two days. A story about
one of these beats any old one (Kane's Ballon d'Or, posted the morning after,
outran every short before it) — but ONLY if the episode is already written up
in the subject's English Wikipedia article, because it will be checked there:
${news.map((n) => `- ${n.title} (${n.outlet})`).join('\n')}
` : ''}${hot.length ? `
TRENDING — yesterday's most-read English Wikipedia articles, i.e. what people are
searching for right now. If any of these fits this channel's scope (a person,
club, event or thing it would cover), make your FIRST proposals about them:
${hot.join(' | ')}
` : ''}${lane.categoryId === '17' ? STAR_STRATEGY : ''}${facts ? `
STAR FACTS — real lines from these stars' English Wikipedia articles. Every
story about one of these stars MUST be one of these lines (same event, same
year, "article" = the article named), not anything else you think you know:
${facts}
` : ''}
Propose 10 stories like these. Rules:
- ${story.scope}
- It must be documented in that subject's English Wikipedia article.
- "article": the EXACT English Wikipedia article title of the person, event or thing.
- "subject": the name a photo caption would use (e.g. "${story.captionExample}"), no parentheses.
- "moment": one sentence naming the episode, with its year.
- "title": under 55 characters, opens on the name people know, states the shocking
  fact or twist in plain words, curiosity gap, and ENDS WITH ONE fitting emoji
  (😱 🤯 💀 🔥 🏆 😳 💔) — 121 of the 176 biggest football Shorts had one.
  Capitalise like the examples. Never promise something the article cannot back.
- Do NOT reuse anything already posted:
${avoid.map((t) => `  - ${t}`).join('\n') || '  (nothing yet)'}

Return ONLY JSON: {"stories": [{"article": "...", "subject": "...", "moment": "...", "title": "..."}]}`;
  return parseJson(await ai.generateText(prompt, { maxTokens: 3000, temperature: 0.95 })).stories || [];
}

/**
 * Follow-up episodes for a short that did well: what happened AFTER its moment,
 * taken from the same article, so Part 2 is verified exactly the way Part 1 was.
 */
async function proposeSequel(ai, lane, parent, previously, brief) {
  const prompt = `You plan sequels for the YouTube Shorts channel "${lane.name}".

A short about ${parent.subject} did well with viewers. Its episode: ${parent.moment}
Its narration:
"""
${previously}
"""

Wikipedia article "${brief.title}":
"""
${brief.text.slice(0, 12000)}
"""

Propose up to 4 follow-up episodes for the next part. Rules:
- Each must happen AFTER that episode and continue the same story: the fallout,
  the consequence, the next chapter, how it ended for them.
- It must be stated in the article above, and not already told in the narration.
- Most dramatic first: the one a viewer of the first part would most want to
  know. The first one that passes the fact-check is the one that gets made.
- "moment": one sentence naming the follow-up episode, with its year.
- "title": under 50 characters, states the twist in plain words, and makes sense
  to a viewer who never saw the first part. Ends with ONE fitting emoji, no "Part" (added later).

Return ONLY JSON: {"stories": [{"moment": "...", "title": "..."}]}`;
  return parseJson(await ai.generateText(prompt, { maxTokens: 2000, temperature: 0.7 })).stories || [];
}

/**
 * The part of a long article that is about this episode. Famous players'
 * articles run past 60,000 characters and the episode (Maradona's 1986
 * quarter-final, Zidane's 2006 final) sits deep inside; handing the writer the
 * first 12,000 meant writing from memory, and the fact-check then cut 12 of 14
 * sentences. The lead paragraph plus the paragraphs that mention the episode's
 * own words, in article order, is what the writer and checker both see.
 *
 * maxChars stays under what supported() and narrate() actually read (9,000).
 * At 10,000, a late-article episode — the very kind this exists for — was
 * kept and then sliced off: Mbappé's "Chinese dictator" paragraph (2026-10-30)
 * sat at characters 8,000-9,400, so the checker saw the quote but not the
 * apology, answered NO, and the story was dropped.
 */
const STOP = new Set('with that this from their after when which into over about were have been they them then than also what while where there would could his her the and for its was who how why one two'.split(' '));
function focusBrief(brief, story, maxChars = 8500) {
  const paras = brief.text.split(/\n{2,}|\n(?=[A-Z])/).map((p) => p.trim()).filter((p) => p.length > 40);
  // A series part's `focus` adds words to steer which paragraphs are kept,
  // without loading the moment (which the article check reads) with detail.
  const keys = [...new Set(fold(`${story.moment} ${story.title || ''} ${story.focus || ''}`).match(/[a-z0-9]{4,}/g) || [])].filter((k) => !STOP.has(k));
  const scored = paras.map((p, i) => {
    const f = fold(p);
    return { i, p, score: keys.reduce((a, k) => a + (f.includes(k) ? (/^\d{4}$/.test(k) ? 3 : 1) : 0), 0) };
  });
  const keep = new Set([0]);
  let size = paras[0]?.length || 0;
  for (const s of [...scored].sort((a, b) => b.score - a.score)) {
    if (s.score === 0 || size + s.p.length > maxChars) continue;
    keep.add(s.i);
    size += s.p.length;
  }
  const text = scored.filter((s) => keep.has(s.i)).map((s) => s.p).join('\n\n');
  return { ...brief, text };
}

async function supported(ai, story, brief) {
  const prompt = `Wikipedia article "${brief.title}":
"""
${brief.text.slice(0, 9000)}
"""

Does this text describe this specific episode in enough detail to narrate it:
"${story.moment}"
Answer YES or NO.`;
  try {
    return /^\W*yes\b/i.test(String(await ai.generateText(prompt, { maxTokens: 400, temperature: 0 })).trim());
  } catch {
    return false;
  }
}

function unsourcedNumbers(text, brief) {
  const f = (t) => t.normalize('NFKD').replace(/,/g, '').toLowerCase();
  const src = f(brief);
  return [...new Set(f(text).match(/\d[\d.:]*/g) || [])]
    .map((x) => x.replace(/[.:]+$/, ''))
    .filter((x) => x.length > 1 && !src.includes(x));
}

/**
 * Sentence-level fact check against the brief. The number check alone let a
 * Zidane draft through that swapped who scored first in the 2006 final and
 * invented a free kick — every figure in it existed somewhere in the article.
 * Returns the sentences the source does not support.
 */
async function unsupportedSentences(ai, text, brief) {
  const sentences = text.match(/[^.!?]+[.!?]+["'”’]?/g) || [text];
  const numbered = sentences.map((s, i) => `${i + 1}. ${s.trim()}`).join('\n');
  const prompt = `You are a strict fact-checker. SOURCE:
"""
${brief.text.slice(0, 11000)}
"""

NARRATION, numbered by sentence:
${numbered}

For each sentence, decide whether every factual claim in it (who did what,
when, in what order, scores, results, quotes) is stated or directly implied
by the SOURCE. Pure scene-setting with no factual claim ("Tension mounted.")
counts as supported. A claim the source does not mention counts as unsupported.

Return ONLY JSON: {"unsupported": [sentence numbers]}`;
  try {
    const out = parseJson(await ai.generateText(prompt, { maxTokens: 1500, temperature: 0 }));
    return new Set((out.unsupported || []).map(Number).filter((n) => n >= 1 && n <= sentences.length).map((n) => n - 1));
  } catch {
    return null;   // the checker failed: treat the draft as unverified
  }
}

/**
 * Gemini writes the script when it can: it tells a story in order, where
 * gpt-oss at low reasoning drifted into a backwards career recap. Its free tier
 * is 20 requests a day, which two shorts with retries fit inside; when it is
 * out, AITextService falls through to the backups on its own.
 */
function writerAI() {
  const prev = process.env.AI_TEXT_PROVIDER;
  process.env.AI_TEXT_PROVIDER = process.env.STORY_WRITER_PROVIDER || 'gemini';
  const writer = new AITextService({});
  if (prev === undefined) delete process.env.AI_TEXT_PROVIDER; else process.env.AI_TEXT_PROVIDER = prev;
  return writer;
}

/**
 * Why a narration's first sentence would not stop a thumb, or null. Measured
 * on the channel: the 95%-retention short opened "Ten days after scoring an
 * own goal, he was murdered." (10 words, the twist stated flat); Real Madrid
 * 2022 Part 1 opened on a 14-word summary that gave the comeback away.
 */
const HYPE = /\b(breathtaking|stunning|incredible|legendary|epic|unbelievable|iconic|remarkable|historic|orchestrated|extraordinary|astonishing)\b/i;
function hookProblem(text) {
  const first = (String(text).match(/^[^.!?]+[.!?]/) || [String(text)])[0].trim();
  const n = first.split(/\s+/).filter(Boolean).length;
  if (n > 14) return `the first sentence is ${n} words; keep it to 12`;
  if (HYPE.test(first)) return `"${first.match(HYPE)[0]}" is a hype adjective; state the fact instead`;
  if (/^(on|in|during|back in)\s+(\d|the\s+\d|(january|february|march|april|may|june|july|august|september|october|november|december)\b)/i.test(first)) return 'it opens on a date; open on the moment or the fact';
  return null;
}

async function narrate(ai, story, brief, writer = writerAI(), WORDS = DEFAULT_WORDS) {
  // A sequel is told as the next chapter: what Part 1 said is shown so it is
  // not retold, and one reconnecting line lets a viewer who missed it follow.
  const sequel = story.previously ? `
This is PART ${story.part} of a series. The previous part already told the story
below, so do NOT retell it. Open with ONE sentence that reconnects the viewer to
it, then tell what happened NEXT:
"""
${story.previously}
"""
` : '';
  // A planned series part (series.js) tells its own act and no more: the next
  // act is held back so this one can stop on its turning point.
  const series = story.series ? `
This is PART ${story.part} of ${story.series.of} of the series "${story.series.name}".
Tell ONLY this part's episode, as its own complete mini-story.${story.series.nextMoment ? `
The next part will tell this, so say NONE of it: "${story.series.nextMoment}"
End this part on its moment of highest tension, not on a wrap-up of the series.
(A line saying the next part is coming is added after your narration; do not write one.)` : ''}${story.series.note ? `
${story.series.note}` : ''}
Write scorelines and odds as digits with a dash, like 3–1 or 5000–1.
` : '';
  const base = `Write the narration for a ${WORDS.target}-word YouTube Short about ${story.subject}.
The episode: ${story.moment}
${sequel}${series}${story.writerNote ? `${story.writerNote}
` : ''}
SOURCE — the only place you may take names, dates, numbers, clubs, scores and
quotes from. If a detail is not here, it does not exist:
"""
${brief.text.slice(0, 9000)}
"""

Structure:
1. THE HOOK, the first sentence, at most 12 words. It drops the viewer into the
   moment of highest tension, or states the most shocking fact flatly. It must
   NOT summarise the story or give away how it ends. The shapes that hold a
   thumb (shapes only; every fact must come from the SOURCE):
   - the twist stated flat: "Ten days after scoring an own goal, he was murdered."
   - the low point: "Real Madrid were two goals down and thirty minutes from going out."
   - the number first: "Seventeen minutes. That is all Karim Benzema needed."
   - the contradiction: "Rome's most feared emperor was terrified of his own guards."
   Name ${story.subject} in the first or second sentence. No hype adjectives
   (breathtaking, stunning, incredible, legendary, epic, unbelievable, iconic,
   remarkable, historic), and never open on a date ("On 9 March 2022...").
2. The second sentence opens a loop: what was at stake or about to go wrong,
   left unresolved so the viewer has to stay for the answer.
3. Tell the episode in the order the SOURCE gives it, building tension sentence
   by sentence. Who scored, when and how must match the source exactly — if the
   source does not say how a goal was scored, do not describe it.
4. The payoff: what actually happened, and what it cost or meant.
5. End with ONE short question built on the payoff that makes people answer in
   the comments ("Was this the cruellest night in football?", "Who was really to
   blame?"). Never "subscribe", "like" or "let me know".

KEEP IT SHORT: the Shorts that pull millions run 15-30 seconds. Every sentence
must earn its place; cut background the viewer does not need.

Style: spoken, energetic storytelling, short sentences, present the facts
vividly. Past tense. No "you", no "imagine", no "subscribe", no headings, no
emojis, no stage directions. Never name the structure out loud: no "hook",
"payoff", "stakes" or "twist" (the Kane short said "the incredible payoff
arrived"). ${WORDS.min}-${WORDS.max} words. Return only the narration.`;

  let feedback = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = await writer.generateText(attempt === 1 ? base
      : `${base}\n\nYour previous draft broke a rule (${feedback || (attempt === 2 ? 'length or invented figures' : 'invented figures')}). Use ONLY numbers that appear in the source.`,
    { maxTokens: 1400, temperature: 0.6 });
    feedback = '';
    // Non-breaking and figure hyphens (U+2010-2012) come back from the model in
    // "Paris Saint‑Germain" and do not survive every font or the TTS.
    const text = String(raw).replace(/^#+.*$/gm, '').replace(/\*\*/g, '').replace(/[‐-‒]/g, '-').replace(/\s+/g, ' ').trim();
    // The model keeps reaching for a match minute or a cap count the article
    // never states. Rather than lose the story, cut exactly the sentences that
    // carry an unsourced figure; the rest is verified prose.
    const bad = unsourcedNumbers(text, brief.text);
    const kept = bad.length
      ? (text.match(/[^.!?]+[.!?]+["'”’]?/g) || [text]).filter((s) => unsourcedNumbers(s, brief.text).length === 0).join(' ').replace(/\s+/g, ' ').trim()
      : text;
    if (bad.length) logger.info(`dropped sentences with unsourced figures (${bad.join(', ')})`);
    // A weak opener goes back before the fact-check spends a call on it; the
    // last attempt ships whatever it has rather than losing the story.
    const weak = hookProblem(kept);
    if (weak && attempt < 3) {
      logger.info(`draft ${attempt}: weak hook (${weak}): "${(kept.match(/^[^.!?]+[.!?]/) || [kept])[0].slice(0, 90)}"`);
      feedback = `the hook: ${weak}`;
      continue;
    }
    if (words(kept) < WORDS.min) {
      logger.warn(`draft ${attempt}: only ${words(kept)} words after the figure check`);
      continue;
    }

    const flagged = await unsupportedSentences(ai, kept, brief);
    if (!flagged) {
      logger.warn(`draft ${attempt}: fact-check unavailable; not shipping unverified narration`);
      continue;
    }
    const sentences = kept.match(/[^.!?]+[.!?]+["'”’]?/g) || [kept];
    const checked = sentences.filter((_, i) => !flagged.has(i)).join(' ').replace(/\s+/g, ' ').trim();
    if (flagged.size) logger.info(`fact-check cut ${flagged.size} sentence(s): ${[...flagged].map((i) => `"${sentences[i].trim().slice(0, 60)}"`).join(' | ')}`);
    // A bare cut can strand the next sentence: an Alexander draft lost "Darius
    // offered half his empire" and kept "Alexander refused." So the writer gets
    // one chance to retell it without the flagged claims; the retelling only
    // ships if it comes back from the checker clean.
    if (flagged.size) {
      const fixed = String(await writer.generateText(`${base}\n\nHere is a draft:\n"""\n${kept}\n"""\n`
        + `A fact-checker could not find these claims in the SOURCE; leave them out:\n`
        + `${[...flagged].map((i) => `- ${sentences[i].trim()}`).join('\n')}\n`
        + 'Rewrite the whole narration so it still flows without them.', { maxTokens: 1400, temperature: 0.4 }).catch(() => ''))
        .replace(/^#+.*$/gm, '').replace(/\*\*/g, '').replace(/[‐-‒]/g, '-').replace(/\s+/g, ' ').trim();
      const n = words(fixed);
      if (fixed && !unsourcedNumbers(fixed, brief.text).length && n >= WORDS.min && n <= WORDS.max) {
        const again = await unsupportedSentences(ai, fixed, brief);
        if (again && again.size === 0) { logger.info('rewrite passed the fact-check clean'); return fixed; }
        logger.info(`rewrite still had ${again ? again.size : '?'} unsupported sentence(s); using the cut draft`);
      }
    }
    // Cutting more than a quarter of the story leaves holes in the telling.
    // Losing the first sentence loses the hook — a Messi story opened on "The
    // Argentine star..." without ever naming him. The title is already checked
    // against the article and is written to stop a thumb, so it opens instead.
    const opener = String(story.title || '').replace(/[^\p{L}\p{N}\s'’,-]/gu, '').replace(/\s+/g, ' ').trim();
    const final = flagged.has(0) && opener ? `${opener}. ${checked}` : checked;
    const n = words(final);
    if (flagged.size <= Math.ceil(sentences.length / 4) && n >= WORDS.min && n <= WORDS.max) return final;
    logger.warn(`draft ${attempt}: ${n} usable words, unsourced figures: ${bad.join(', ') || 'none'}`);
  }
  return null;
}

/**
 * Narrate `text` in the lane's voice and cut it over `photos` (downloaded
 * Commons files) into <dataRoot>/shorts/video/<id>_short.mp4. Shared by the
 * story shorts and the Sunday roundup, so a change of look happens in one place.
 * Returns { video, seconds }, or { skip } when the narration runs out of bounds.
 */
async function renderStills(lane, id, text, photos, { style = 'v1', title = '', tag = null, label = null, next = null, chapters = [], clipTeams = [], stockClips = true } = {}) {
  const base = (...p) => path.join(ROOT, lane.dataRoot, ...p);
  const factory = new ShortsFactory({});
  const dirs = Object.fromEntries(['audio', 'captions', 'copy', 'video', 'work'].map((k) => [k, base('shorts', k)]));
  for (const d of Object.values(dirs)) await fsp.mkdir(d, { recursive: true });

  const audio = path.join(dirs.audio, `${id}_short.mp3`);
  const narration = await factory.narrateWithTiming(text, lane.voice, audio);
  const seconds = await factory.probeDuration(audio);
  if (seconds > 178) return { skip: `${seconds.toFixed(0)}s is over the 3-minute Shorts limit` };
  if (seconds < 20.5) return { skip: `${seconds.toFixed(0)}s is under the 20s quality gate` };
  const video = path.join(dirs.video, `${id}_short.mp4`);

  // The second look (utils/short-style-v2.js). Anything going wrong in it —
  // Python missing on a runner, a model download that failed — falls back to
  // the v1 render below on the same narration, so a post is never lost to it.
  if (style === 'v2') {
    const workDir = path.join(dirs.work, id);
    try {
      const v2 = await renderStoryV2({
        words: narration.words, audioPath: audio, photos: photos.map((p) => p.path), title, tag, label, next, chapters,
        look: lane.look || 'football', theme: lane.theme || lane.look || 'football',
        clipThemes: lane.categoryId === '17' ? clipTeams.map(teamTheme).filter(Boolean).slice(0, 1) : [], stockClips,
        accent: lane.captionHighlight, outputPath: video, workDir, logger
      });
      // A CC BY track has to be credited in the description (utils/music.js).
      return { video, seconds, style: 'v2', music: v2.music || null };
    } catch (error) {
      logger.warn(`${id}: v2 render failed (${String(error.message).slice(0, 160)}); rendering the v1 look`);
    } finally {
      await fsp.rm(workDir, { recursive: true, force: true });
    }
  }

  const captions = path.join(dirs.captions, `${id}_short.ass`);
  // Captions never wrap (WrapStyle 2), so three long words ran off the frame
  // ("CONSULTED HIS ASSISTANT"); two words at 84px stays inside 1080px.
  await fsp.writeFile(captions, factory.buildCaptions(narration.words,
    { wordsPerChunk: 2, fontSize: 84, ...(lane.captionHighlight ? { highlightColor: lane.captionHighlight } : {}) }));

  const count = Math.max(photos.length, Math.ceil(seconds / SECONDS_PER_IMAGE));
  const per = seconds / count;
  const clips = [];
  for (let i = 0; i < count; i++) {
    const clip = path.join(dirs.work, `${id}_${i}.mp4`);
    await factory.stillToClip(photos[i % photos.length].path, per, clip);
    clips.push(clip);
  }
  await factory.renderShort({ storyClips: clips, motionClip: null, layout: 'full', audioPath: audio, captionPath: captions, outputPath: video });
  await Promise.all(clips.map((c) => fsp.unlink(c).catch(() => {})));
  return { video, seconds, style: 'v1' };
}

/**
 * Which look a lane's next story gets. `lane.v2`: 'on', 'off' (default), or
 * 'ab' — the two looks alternate by count, so after two weeks they have the
 * same number of posts and their views and average-watched can be compared
 * straight from stories.json's `style` field.
 */
function chooseStyle(lane, done) {
  if (lane.v2 === 'on') return 'v2';
  if (lane.v2 !== 'ab') return 'v1';
  const n = (s) => done.filter((d) => d.style === s).length;
  return n('v2') <= n('v1') ? 'v2' : 'v1';
}

// Subjects any lane picked in this process. Every lane sees the same trending
// list, and on 2026-10-22 AFTER CACHE and Viral Vault Clip both chose
// Elizabeth Holmes; one channel per subject per day.
const takenThisRun = new Set();

/**
 * `sequelOf` is a stories.json entry (with its videoId) to continue: the next
 * part of that story replaces a fresh pick. See scripts/autopilot/sequels.js.
 */
async function makeStoryShort(laneName, { dryRun = false, sequelOf = null, story: pinned = null, seriesDue = null, rerender = false } = {}) {
  const lane = LANES.find((l) => l.name.toLowerCase() === String(laneName).toLowerCase());
  if (!lane) throw new Error(`no lane "${laneName}"`);
  if (seriesDue) return makeSeriesPart(lane, seriesDue, { dryRun, rerender });
  const base = (...p) => path.join(ROOT, lane.dataRoot, ...p);

  const ai = new AITextService({});
  const writer = writerAI();
  const research = new ResearchService();
  const archival = new ArchivalImageService();
  const storiesPath = base('stories.json');
  const done = readJson(storiesPath, []);
  const ledger = readJson(base('shorts', 'uploads.json'), {});
  const avoid = [...done.map((d) => `${d.subject}: ${d.moment}`),
    ...Object.entries(ledger).filter(([id]) => !id.startsWith('reddit-')).map(([, v]) => String(v.title || '').replace(/\s*#Shorts$/i, ''))].slice(-120);
  // Same subject at most once a fortnight, so the feed is not one player.
  const recent = new Set(done.filter((d) => Date.now() - Date.parse(d.at) < 14 * 86400000).map((d) => fold(d.subject)));
  const hot = sequelOf || pinned ? [] : await trending();
  if (hot.length) logger.info(`trending: ${hot.slice(0, 12).join(' | ')} …`);
  const news = sequelOf || pinned || !lane.news ? [] : (await footballNews()).slice(0, 30);
  if (news.length) logger.info(`news: ${news.length} headlines, e.g. ${news.slice(0, 3).map((n) => n.title).join(' | ')}`);

  // Posted is posted. A story asked for by name skips the fortnight rule, so
  // asking twice for the same news in other words would post it twice; the
  // same article within a week is refused instead.
  if (pinned) {
    const again = done.find((d) => fold(d.article) === fold(pinned.article) && Date.now() - Date.parse(d.at) < 7 * 86400000);
    if (again) throw new Error(`already posted from "${pinned.article}" on ${again.at.slice(0, 10)}: "${again.title}"`);
  }

  // A sequel continues one story, so its article is fixed and read once, and
  // Part 1's own narration tells the planner and the writer what not to repeat.
  let sequel = null;
  if (sequelOf) {
    const full = await research.buildBriefFromArticle(sequelOf.article, { maxChars: 150000 }).catch(() => null);
    if (!full || full.text.length < 3000) throw new Error(`no usable article text for ${sequelOf.article}`);
    const copy = await fsp.readFile(base('shorts', 'copy', `${sequelOf.id}_short.txt`), 'utf8').catch(() => '');
    const previously = copy.split(/\n\nSource:/)[0].replace(/^◀.*\n+/, '').trim() || sequelOf.moment;
    sequel = { full, previously, part: (sequelOf.part || 1) + 1, root: sequelOf.root || sequelOf.id };
    logger.info(`sequel: Part ${sequel.part} of ${sequelOf.id}`);
  }

  const factItems = !sequel && !pinned && lane.categoryId === '17' ? await starFactItems(research).catch(() => []) : [];
  const facts = factsText(factItems);
  if (facts) logger.info(`star facts: ${facts.split('\n').filter((l) => !l.startsWith('  ')).map((l) => l.split(' (')[0]).join(', ')}`);
  for (let round = 1; round <= (sequel || pinned ? 1 : 3); round++) {
    let stories;
    try {
      // Round 2 drops the trending list, in case it pulled round 1 off-scope.
      // A pinned story (asked for by name) skips the proposal step entirely,
      // and still goes through the same article check, fact-check and render.
      stories = pinned ? [pinned] : sequel
        ? (await proposeSequel(ai, lane, sequelOf, sequel.previously, focusBrief(sequel.full, sequelOf, 11500)))
          .map((s) => ({ ...s, article: sequelOf.article, subject: sequelOf.subject }))
        : [
          // round 1 opens on stories made from the stars' own article lines
          ...(round === 1 ? await factStories(ai, factItems).catch(() => []) : []),
          ...await propose(ai, lane, avoid, round === 1 ? hot : [], round === 1 ? news : [], round < 3 ? facts : '')
        ];
    } catch (error) {
      logger.warn(`proposal round ${round} failed: ${error.message}`);
      continue;
    }
    for (const story of stories) {
      const subject = String(story.subject || '').replace(/\([^)]*\)/g, '').trim();
      if (!story.article || !subject) continue;
      // The fortnight-per-subject rule is for fresh picks; a sequel is the same subject by design.
      if (!sequel && !pinned && (recent.has(fold(subject)) || takenThisRun.has(fold(subject)))) continue;
      if (done.some((d) => fold(d.moment) === fold(story.moment))) continue;

      let brief;
      if (sequel) {
        // Keyed on both episodes, so the line reconnecting to Part 1 is in the
        // source the fact-checker reads instead of being cut as unsupported.
        brief = focusBrief(sequel.full, { moment: `${sequelOf.moment} ${story.moment}`, title: story.title });
      } else {
        const full = await research.buildBriefFromArticle(story.article, { maxChars: 150000 }).catch(() => null);
        if (!full || full.text.length < 3000) { logger.info(`skip ${story.article}: thin or missing article`); continue; }
        brief = focusBrief(full, story);
      }
      if (!(await supported(ai, story, brief))) { logger.info(`skip "${story.moment}": not in the article`); continue; }

      // Photos of the episode itself first (the match, the night, that year),
      // then the subject's own pictures (main image, article, Commons
      // category) — but none taken after the episode: a 2026 photo in a 2017
      // story shows the wrong team, the wrong kit, the wrong face.
      const year = eventYear(story.moment);
      const event = year ? await archival.eventPhotos(eventQueries(story.moment, subject, year), { year, must: eventKeys(story.moment, subject), limit: 6 }).catch(() => []) : [];
      const own = (await archival.gatherForArticle(brief.title || story.article, subject, { total: 14 }).catch(() => []))
        .filter((x) => !OFF_TOPIC.test(x.title) && !NOT_A_PHOTO.test(x.title) && !tooLate(x, year) && !(lane.categoryId === '17' && NOT_THE_PLAYER.test(x.title)))
        .sort(year ? byEra(year) : () => 0)
        // on football, the subject's own photos must name him (no club team sheets, no scanned documents)
        .filter((x) => !(lane.categoryId === '17' && (!hasKey(x.title, [folded(subjectKey(subject))]) || /\bdocument\b/i.test(x.title))));
      // near the episode when there are enough of those (no teenage Vinicius in a
      // 2022 story); otherwise the closest older ones (a 2004 retirement story is
      // told with his playing-days photos)
      const near = own.filter((x) => !outOfEra(x, year, isTeam(subject) ? 'team' : 'person'));
      const pool = near.length >= 3 ? near : own;
      const found = [...new Map([...event, ...pool].map((x) => [x.title, x])).values()].slice(0, 10);
      if (event.length) logger.info(`${subject}: ${event.length} photo(s) of the episode itself`);
      if (found.length < 3) { logger.info(`skip ${subject}: only ${found.length} usable photo(s)`); continue; }

      const text = await narrate(ai, { ...story, subject, writerNote: lane.story?.writerNote, ...(sequel ? { previously: sequel.previously, part: sequel.part } : {}) },
        brief, writer, lane.story?.words || DEFAULT_WORDS);
      if (!text) { logger.info(`skip ${subject}: no clean narration`); continue; }

      // The model still stacks emojis ("😳💀") despite the rule; keep the first.
      let seen = false;
      let title = String(story.title)
        .replace(/\p{Extended_Pictographic}️?/gu, (e) => (seen ? '' : ((seen = true), e)))
        .replace(/[‐-‒]/g, '-')   // non-breaking hyphens, as in the narration
        .replace(/\s+/g, ' ').trim().slice(0, sequel ? 70 : 80);
      // The title is a claim too: "Kevlar Vests Were First Made for WWII Soldiers"
      // went out on 8 Nov (Kevlar dates from 1965; the WWII vests were doron
      // plate). A title the article does not back is not posted.
      const titleCheck = await unsupportedSentences(ai, `${title.replace(/\p{Extended_Pictographic}️?/gu, '').trim().replace(/[.!?]*$/, '.')}`, brief).catch(() => null);
      if (!titleCheck || titleCheck.size) { logger.info(`skip ${subject}: title not backed by the article: "${title}"`); continue; }
      if (sequel) title = `${title.replace(/[.!?]+$/, '')} (Part ${sequel.part})`;
      let id = sequel
        ? `story-${slug(subject, 20)}-p${sequel.part}-${slug(story.moment, 12)}`
        : `story-${slug(subject, 20)}-${slug(story.moment, 16)}`;
      while (ledger[id]) id += 'x';
      takenThisRun.add(fold(subject));
      logger.success(`${id}: "${title}" — ${words(text)} words`);
      if (dryRun) return { id, title, text, subject, article: brief.title, photos: found.length, ...(sequel ? { part: sequel.part } : {}) };

      // ---- render
      // Who and what the narration names, each with its own photos on its words.
      const beats = await beatPhotos(archival, await photoPlan(ai, text, story, subject), year, { football: lane.categoryId === '17', subject, text }).catch(() => []);
      if (beats.length) logger.info(`${subject}: photos for ${beats.length} beat(s): ${beats.map((b) => `${b.names[0]}=${b.photos.length}`).join(', ')}`);
      const subjectKeys = titleKeys(subject, 'person');
      const imgDir = base('reference', id);
      const all = [...new Map([...found, ...beats.flatMap((b) => b.photos)].map((x) => [x.title, x])).values()];
      const saved = await archival.downloadArchivalImages(all, imgDir);
      if (saved.length < 3) { logger.info(`skip ${subject}: photo downloads failed`); continue; }
      const pathOf = new Map(saved.map((p) => [p.title, p.path]));
      const chapters = [
        // the subject on their own name, from their own photos that name them
        { names: subjectKeys.slice(-1), photos: found.filter((x) => hasAll(x.title, subjectKeys)).map((x) => pathOf.get(x.title)).filter(Boolean) },
        ...beats.map((b) => ({ names: b.names, photos: b.photos.map((x) => pathOf.get(x.title)).filter(Boolean) }))
      ].filter((c) => c.photos.length && c.names.length);

      const rendered = await renderStills(lane, id, text, saved,
        { style: chooseStyle(lane, done), title, tag: sequel ? `Part ${sequel.part}` : null, chapters,
          // fans of the story's own team, never random people (the first team the narration names)
          clipTeams: beats.filter((b) => b.kind === 'team').map((b) => b.article).slice(0, 1) });
      if (rendered.skip) { logger.warn(`${id}: ${rendered.skip}`); continue; }
      const { video, seconds } = rendered;
      const dirs = { copy: base('shorts', 'copy') };
      // The photos are only needed for this render, and their credits are in the copy.
      await fsp.rm(imgDir, { recursive: true, force: true });

      // The description is the copy file; CC BY photos are only legal credited.
      const credits = saved.map((s) => `• ${s.title.replace(/^File:/, '')} — ${String(s.artist || 'unknown').slice(0, 80)}, ${s.license}`);
      // A sequel's first description line points back, for anyone who lands here first.
      const back = sequel ? `◀ Part ${sequel.part - 1}: https://youtube.com/shorts/${sequelOf.videoId}\n\n` : '';
      await fsp.writeFile(path.join(dirs.copy, `${id}_short.txt`),
        `${back}${text}\n\nSource: ${brief.url}\nPhotos (Wikimedia Commons):\n${credits.join('\n')}${rendered.music ? `\n\n${rendered.music}` : ''}`);

      const queuePath = base('queue.json');
      const queue = readJson(queuePath, { topics: [] });
      queue.topics.push({ id, topic: story.moment, keywords: [subject, ...(lane.story || DEFAULT_STORY).tags], status: 'short', shortTitle: title, article: brief.title, categoryId: lane.categoryId });
      await fsp.writeFile(queuePath, JSON.stringify(queue, null, 2));

      const series = sequel ? { sequelOf: sequelOf.id, part: sequel.part, root: sequel.root } : {};
      done.push({ id, subject, article: brief.title, moment: story.moment, title, at: new Date().toISOString(), style: rendered.style, ...series });
      await fsp.writeFile(storiesPath, JSON.stringify(done, null, 2));
      return { id, title, video, seconds, ...series };
    }
  }
  throw new Error('no story survived verification this run');
}

/**
 * One part's source: each of its articles cut to the paragraphs about this
 * episode (focusBrief), together under the 8,500 characters the writer and the
 * checker read, each headed by its title so the checker knows where it is.
 */
async function seriesBrief(research, part) {
  const per = Math.floor(8500 / part.articles.length);
  const briefs = [];
  for (const article of part.articles) {
    const full = await research.buildBriefFromArticle(article, { maxChars: 150000 }).catch(() => null);
    if (!full || full.text.length < 1500) throw new Error(`no usable article text for "${article}"`);
    briefs.push({ ...focusBrief(full, part, per), url: full.url });
  }
  return {
    title: briefs[0].title,
    url: briefs[0].url,
    urls: briefs.map((b) => b.url),
    text: briefs.map((b) => `${b.title}:\n${b.text}`).join('\n\n')
  };
}

/**
 * Every story's photos follow its narration, beat by beat (2026-11-07, the
 * user: "find pictures that match what u saying", on ALL content). Once the
 * narration is written, the model lists who and what it names — each person,
 * club, ground, trophy — with the exact words that name them and their
 * English Wikipedia article. Each gets its own photos, and they come up on
 * those words (short-style-v2 chapters).
 */
async function photoPlan(ai, text, story, subject) {
  const prompt = `Narration of a YouTube Short:
"""
${text}
"""
The story: ${story.moment}

List what a viewer should SEE as each thing is named: every person, team,
stadium, trophy or competition the narration names, other than ${subject}
(already covered). For each give:
- "words": the word or words in the narration that name it, lower case, as
  spoken (surnames; "keeper" if that is how a goalkeeper is referred to)
- "article": its exact English Wikipedia article title
- "kind": "person", "team", "place" or "trophy"
At most 7 items, most important first. Return ONLY JSON:
{"items": [{"words": ["neuer"], "article": "Manuel Neuer", "kind": "person"}]}`;
  try {
    const items = parseJson(await ai.generateText(prompt, { maxTokens: 1200, temperature: 0.1 })).items || [];
    return items.filter((x) => x && x.article && Array.isArray(x.words) && x.words.length).slice(0, 7);
  } catch {
    return [];
  }
}

/** The words a file name must contain to be a photo of `article` (surname, club name, trophy name). */
function titleKeys(article, kind) {
  const plain = String(article).replace(/\([^)]*\)/g, '').trim();
  const parts = plain.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[\s-]+/)
    .filter((w) => w.length >= 3 && !/^(the|and|of|de|del|la|fc|cf|club|football|f\.c\.)$/.test(w));
  if (kind === 'person') return parts;                    // EVERY name: "Damian Martinez" is not Emiliano
  return parts.slice(0, 2);                               // "real madrid", "champions league"
}
// Dutch ij = y, so Cruijff matches Cruyff.
const folded = (title) => String(title).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ij/g, 'y');
const hasKey = (title, keys) => keys.some((k) => folded(title).includes(k));
const hasAll = (title, keys) => keys.every((k) => folded(title).includes(k));
// A team photo is the team, not its logo, campus, shop or other sections.
const NOT_THE_TEAM = /\b(logo|crest|badge|campus|handball|basketball|volleyball|futsal|women|womens|frauen|femenino|feminino|ladies|bus|shop|store|office|building|headquarters|museum|academy|youth|u19|u21|u23|mascot|ads?|advert|advertising|sponsor|balm|mannschaftsbus|teambus)\b/i;
// A trophy photo is the trophy, not a beer can, a medal or a museum case.
const NOT_THE_TROPHY = /\b(can|beer|heineken|medal|medals|museum|poster|logo|ball|balls|ballen|ticket|replica|sticker|stamp|minister|president|sheikh|hasina|views|governor|mayor|tour|takaichi|cabinet)\b/i;
// Not a photograph at all.
const NOT_A_PHOTO = /(\bhistogram|\bchart|\bmap\b|diagram|graph|\btable\b|host countries|\bflag|\blogo|\bkit\b|\bsvg$|platzierung|placement|ranking|standings|before the first|territor|\bextent\b|\bcampaigns?\b|siege\w*\.png|genealog|descendante|famille|\bjersey|\bshirt\b|adidas|nike|puma)/i;
/** Does this file show the planned thing, by its name? */
function shows(title, item, keys) {
  if (NOT_A_PHOTO.test(title)) return false;
  if (item.kind === 'person') return hasAll(title, keys);
  if (item.kind === 'team') return hasKey(title, keys) && !NOT_THE_TEAM.test(title);
  if (item.kind === 'trophy') return /trophy/i.test(title) && hasKey(title, keys) && !NOT_THE_TROPHY.test(title);
  return hasKey(title, keys);
}

/**
 * Photos for each planned beat: from its own article and Commons category,
 * the file name must name it (an Arsenal Community Shield photo is not
 * "Emiliano Martinez"), nothing dated after the episode, closest year first.
 * A trophy with no free photo of the winners falls back to the trophy itself.
 * Returns [{ names, photos: [image records], article }].
 */
// In a story from before photography, a place is shown by art, ruins and finds:
// not today's hospitals, aerial shots, stations or anything dated 19xx/20xx.
const MODERN = /(\bhospital|\bhotel|\bairport|aerial|wikiair|drone|\buniversity|\bstation|\bstreet|\bbus\b|\btram|\bmall|parking|\bstadium|\bhdr\b|panorama|skyline|pikiwiki|\b(19|20)\d\d\b)/i;

async function beatPhotos(archival, plan, year, { football = false, subject = '', text = '' } = {}) {
  const out = [];
  // Outside football a beat must be a NAME the narration says with a capital
  // (Caesar's "slaves" pulled an 18th-century British anti-slavery medallion).
  const named = (w) => new RegExp('(^|[^A-Za-z])' + w.charAt(0).toUpperCase() + w.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), '').test(text);
  const ancient = !year;   // no 1800-2099 year in the moment
  for (const item of plan) {
    // teams and trophies are football things; elsewhere "triumph" found Leopold I of Austria
    if (!football && (item.kind === 'team' || item.kind === 'trophy')) continue;
    if (item.kind === 'trophy' && !/\b(won|win|wins|winning|lifted|lift|lifts|champions?|crowned|trophy|title)\b/i.test(text)) continue;
    if (!football && !item.words.some((w) => named(String(w).split(/\s+/).pop()))) continue;
    const keys = titleKeys(item.article, item.kind);
    const subj = folded(subjectKey(subject));
    const team = folded(subjectKey(item.article));
    if (football && item.kind === 'team' && year && subj && team && subj !== team) {
      // the opponent: a photo of that match (both names, that year) or no photo
      // (England v Iran 2022, not Iran v China 2019 or Israel v Wales 1958)
      const match = await archival.eventPhotos([`${subj} ${team} ${year}`, `${team} ${subj} ${year}`], { year, must: [subj, team], minHits: 2, limit: 2 }).catch(() => []);
      const words = item.words.map((w) => String(w).toLowerCase().split(/\s+/).pop()).filter((w) => w.length >= 3);
      // and it must look like a match ("England 6–2 Iran", "v", a competition), not a coat of arms
      const ok = match.filter((x) => !OFF_TOPIC.test(x.title) && !NOT_A_PHOTO.test(x.title)
        && /(\b\d{1,2}\s*[–-]\s*\d{1,2}\b|\bvs?\.?\s|\bversus\b|\bmatch\b|world cup|\beuro\b|league|\bcup\b|fifa|uefa)/i.test(x.title));
      if (ok.length && words.length) out.push({ names: [...new Set(words)], photos: ok, article: item.article, kind: item.kind });
      continue;
    }
    let found = (await archival.gatherForArticle(item.article, item.article.replace(/\([^)]*\)/g, '').trim(), { total: 14 }).catch(() => []))
      .filter((x) => !OFF_TOPIC.test(x.title) && !(football && item.kind === 'person' && NOT_THE_PLAYER.test(x.title)))
      .filter((x) => shows(x.title, item, keys))
      .filter((x) => item.kind === 'trophy' || !tooLate(x, year))
      .filter((x) => !(ancient && item.kind !== 'person' && MODERN.test(x.title)));
    if (year) {
      found.sort(byEra(year));
      const near = found.filter((x) => !outOfEra(x, year, item.kind));
      if (near.length) found = near;
    }
    if (!found.length && item.kind === 'trophy') {
      found = (await archival.fetchArchivalImages(`${item.article} trophy`, { must: ['trophy'], bonus: keys }, { limit: 8 }).catch(() => []))
        .filter((x) => shows(x.title, item, keys));
    }
    const words = item.words.map((w) => String(w).toLowerCase().split(/\s+/).pop()).filter((w) => w.length >= 3);
    if (found.length && words.length) out.push({ names: [...new Set(words)], photos: found.slice(0, 2), article: item.article, kind: item.kind });
  }
  return out;
}

/**
 * A part's photos, downloaded to `dir`, as { saved, chapters }: each group in
 * part.photos fetched from its own article (gatherForArticle), and every group
 * with `names` made a chapter, so the picture follows who the voice is naming.
 */
// Stadium and city articles carry whatever else happened there: Part 1 of
// Real Madrid 2022 showed "2025 NFL Madrid Game" as the Bernabeu.
// (It held two literal backspace characters where \b was meant, so it never matched.)
const OFF_TOPIC = /\b(NFL|American football|rugby|baseball|basketball|NBA|concert|in concert|on tour|wrestling|WWE|AEW|All In 20\d+|Adele|Live 20\d+|festival|gig|luge|skiing|ski|bobsleigh|biathlon|curling|ice hockey|hockey|cricket|tennis|athletics|cycling|formula|motogp|golf|swimming|volleyball|handball)\b/i;

// When the episode happened, from its moment ("On 12 April 2017 ..."), or null.
const eventYear = (moment) => Number((String(moment).match(/\b(1[89]\d{2}|20\d{2})\b/) || [])[1]) || null;
// A photo dated after the episode (one season of grace) belongs to a later story.
const tooLate = (img, year) => Boolean(year && img.year && img.year > year + 1);
// For a footballer, things that carry his name but are not him playing.
const NOT_THE_PLAYER = /\b(museum|museu|hotel|airport|aeroporto|tussauds|wax|figure|statue|mural|graffiti|stamp|poster|logo|signature|autograph|banner|shop|store|jersey on display|potm|tots|totw|fut|player card|rating)\b/i;
// Closest to the episode first; undated photos last.
const byEra = (year) => (a, b) => (a.year ? Math.abs(a.year - year) : 99) - (b.year ? Math.abs(b.year - year) : 99);
const NOT_NAMES = /^(On|In|At|The|A|An|After|Before|During|When|With|His|Her|Their|January|February|March|April|May|June|July|August|September|October|November|December)$/;
/** The proper names in a moment other than the subject: the opponent, the stadium, the competition. */
function eventNames(moment, subject) {
  const subj = new Set(String(subject).split(/\s+/).map((w) => w.toLowerCase()));
  return [...new Set((String(moment).match(/\b[A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+)*/gu) || [])
    .map((p) => p.split(/\s+/).filter((w) => !NOT_NAMES.test(w) && !subj.has(w.toLowerCase())).join(' '))
    .filter((p) => p.length >= 3))];
}
/** Commons searches for the episode: the subject with each other name and the year. */
// What a file name must say to be the subject: a person's surname, but a team's
// own name ("England national football team" gave "team", and a luge "Team
// Relay World Cup 2022" photo went into an England World Cup short).
const TEAMISH = /\b(national|team|club|f\.?c\.?|c\.?f\.?|united|city|real|athletic|sporting|inter|ac|as|ssc|afc)\b/i;
function subjectKey(subject) {
  const plain = String(subject).replace(/\([^)]*\)/g, '').trim();
  if (!TEAMISH.test(plain)) {
    // a surname, skipping suffixes (Vinicius Junior is "Vinicius", not "Junior")
    const w = plain.split(/\s+/).filter((x) => !/^(j[uú]nior|jr\.?|filho|neto|sobrinho)$/i.test(x));
    return (w.length ? w : plain.split(/\s+/)).pop();
  }
  return plain.replace(/\b(national|(association )?football|soccer|team|club|f\.?c\.?|c\.?f\.?|men's|women's)\b/gi, '').replace(/[^\p{L}\s]/gu, '').replace(/\s+/g, ' ').trim() || plain;
}
const isTeam = (subject) => TEAMISH.test(String(subject));
// Too far from the episode: after it (a season's grace), or long before it for
// a person (a teenage Vinicius in a 2022 story) or a team (1954 in a 2022 story).
function outOfEra(img, year, kind) {
  if (!year || !img.year) return false;
  if (img.year > year + 1) return true;
  if (kind === 'person') return img.year < year - 3;
  if (kind === 'team') return img.year < year - 4;
  return false;
}
function eventQueries(moment, subject, year) {
  const surname = subjectKey(subject);
  const others = eventNames(moment, subject).slice(0, 3);
  return [...others.map((o) => `${surname} ${o} ${year}`), `${subject} ${year}`].slice(0, 4);
}
/** Words a file name must carry to count as the episode: the subject's surname or another name in it. */
function eventKeys(moment, subject) {
  const surname = subjectKey(subject);
  return [surname, ...eventNames(moment, subject).flatMap((p) => p.split(/\s+/)).filter((w) => w.length >= 4)];
}

async function seriesPhotos(archival, part, dir) {
  const groups = [];
  const year = eventYear(part.moment);
  for (const g of part.photos) {
    const skip = g.skip ? new RegExp(g.skip, 'i') : null;
    let found;
    if (g.files) {
      // Hand-picked for this beat: exactly these, in this order.
      found = await archival.fetchFiles(g.files).catch(() => []);
    } else {
      const subject = g.article.replace(/\([^)]*\)/g, '').trim();
      found = (await archival.gatherForArticle(g.article, subject, { total: g.n + 8 }).catch(() => []))
        .filter((x) => !OFF_TOPIC.test(x.title) && !NOT_THE_PLAYER.test(x.title) && (!skip || !skip.test(x.title)) && (g.anyYear || !tooLate(x, year)))
        // a person's group: the file name must name them (no club group shots)
        .filter((x) => !g.names?.length || hasAll(x.title, titleKeys(g.article, 'person')))
        .sort(year && !g.anyYear ? byEra(year) : () => 0);
    }
    groups.push({ ...g, found: found.slice(0, g.n || found.length) });
  }
  const all = groups.flatMap((g) => g.found);
  if (all.length < 4) throw new Error(`only ${all.length} usable photos`);
  const saved = await archival.downloadArchivalImages(all, dir);
  if (saved.length < 4) throw new Error('photo downloads failed');
  const pathOf = new Map(saved.map((p) => [p.title, p.path]));
  const chapters = groups.filter((g) => g.names?.length)
    .map((g) => ({ names: g.names, photos: g.found.map((x) => pathOf.get(x.title)).filter(Boolean), ...(g.firstOnce ? { firstOnce: g.firstOnce } : {}) }))
    .filter((c) => c.photos.length);
  return { saved, chapters };
}

/**
 * The planned series part `due` (series.js: { series, part, n, prev }):
 * checked, written, teased, rendered and queued like any story short.
 */
async function makeSeriesPart(lane, due, { dryRun = false, rerender = false } = {}) {
  const { series, part, n, prev } = due;
  const of = series.parts.length;
  const base = (...p) => path.join(ROOT, lane.dataRoot, ...p);
  const id = partId(series, n);
  const ledger = readJson(base('shorts', 'uploads.json'), {});
  // A preview may re-render a part already up (to replace it while private).
  if (ledger[id] && !rerender) throw new Error(`${id} is already posted`);

  const ai = new AITextService({});
  const research = new ResearchService();
  const brief = await seriesBrief(research, part);
  if (!(await supported(ai, part, brief))) throw new Error(`"${part.moment}" is not in its articles`);

  // What Part n-1 said, so it is not retold.
  const previously = prev
    ? (await fsp.readFile(base('shorts', 'copy', `${prev.id}_short.txt`), 'utf8').catch(() => ''))
      .split(/\n\nSource/)[0].replace(/^◀.*\n+/, '').trim() || series.parts[n - 2].moment
    : null;
  const nextPart = series.parts[n] || null;
  // Parts tell a whole act, so they run a little longer than a one-off story.
  // ~30s: a part is one act, told as tight as a one-off (2026-11-07 strategy).
  const WORDS = { min: 58, target: 72, max: 90 };
  const text = await narrate(ai, {
    subject: part.subject, moment: part.moment, title: part.title,
    ...(previously ? { previously, part: n } : { part: n }),
    series: { name: series.name, of, nextMoment: nextPart?.moment || null, note: part.note || null }
  }, brief, writerAI(), WORDS);
  if (!text) throw new Error('no clean narration');

  // The line that sells the next part, checked against the NEXT part's
  // articles; one the checker cannot back is dropped, the promise is not.
  let ending = '';
  if (nextPart) {
    let teaser = part.teaser || '';
    if (teaser) {
      const flagged = await unsupportedSentences(ai, teaser, await seriesBrief(research, nextPart)).catch(() => null);
      if (!flagged || flagged.size) {
        logger.info(`teaser dropped (${flagged ? 'unsupported' : 'check unavailable'}): "${teaser}"`);
        teaser = '';
      }
    }
    ending = ` ${teaser ? `${teaser} ` : ''}Part ${NUMBER_WORDS[n + 1] || n + 1} is next.`;
  }
  const full = `${text}${ending}`;
  const title = (of > 1 ? `${part.title} (Part ${n})` : part.title).slice(0, 90);
  logger.success(`${id}: "${title}" — ${words(full)} words`);
  if (dryRun) return { id, title, text: full, subject: part.subject, article: brief.title, part: n, of };

  const imgDir = base('reference', id);
  const { saved, chapters } = await seriesPhotos(new ArchivalImageService(), part, imgDir);
  const done = readJson(base('stories.json'), []);
  const rendered = await renderStills(lane, id, full, saved, {
    style: chooseStyle(lane, done), title: part.title,
    tag: of > 1 ? `Part ${n} of ${of}` : null, label: part.label || null,
    next: nextPart ? `Part ${n + 1}` : null, chapters, clipTeams: part.clipTeams || [],
    // hand-picked photos: no generic crowd clips (they show other clubs: Galatasaray in Real Madrid Part 4)
    stockClips: !part.photos.every((g) => g.files)
  });
  await fsp.rm(imgDir, { recursive: true, force: true });
  if (rendered.skip) throw new Error(rendered.skip);

  const credits = saved.map((p) => `• ${p.title.replace(/^File:/, '')} — ${String(p.artist || 'unknown').slice(0, 80)}, ${p.license}`);
  const back = prev ? `◀ Part ${n - 1}: https://youtube.com/shorts/${prev.videoId}\n\n` : '';
  await fsp.writeFile(base('shorts', 'copy', `${id}_short.txt`),
    `${back}${full}\n\nSources:\n${brief.urls.join('\n')}\nPhotos (Wikimedia Commons):\n${credits.join('\n')}${rendered.music ? `\n\n${rendered.music}` : ''}`);

  const queuePath = base('queue.json');
  const queue = readJson(queuePath, { topics: [] });
  queue.topics.push({ id, topic: part.moment, keywords: [part.subject, series.name, ...(lane.story || DEFAULT_STORY).tags], status: 'short', shortTitle: title, article: brief.title, categoryId: lane.categoryId });
  await fsp.writeFile(queuePath, JSON.stringify(queue, null, 2));

  const root = partId(series, 1);
  done.push({
    id, subject: part.subject, article: brief.title, moment: part.moment, title, at: new Date().toISOString(), style: rendered.style,
    series: series.key, part: n, of, root, ...(prev ? { sequelOf: prev.id } : {})
  });
  await fsp.writeFile(base('stories.json'), JSON.stringify(done, null, 2));
  return { id, title, video: rendered.video, seconds: rendered.seconds, part: n, root };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const valueFlags = ['--sequel', '--article', '--subject', '--moment', '--title', '--series-part'];
  const laneName = args.find((a, i) => !a.startsWith('--') && !valueFlags.includes(args[i - 1]));
  let sequelOf = null;
  if (args.includes('--sequel')) {
    const sid = args[args.indexOf('--sequel') + 1];
    const lane = LANES.find((l) => l.name.toLowerCase() === String(laneName).toLowerCase());
    const story = lane && readJson(path.join(ROOT, lane.dataRoot, 'stories.json'), []).find((s) => s.id === sid);
    const entry = lane && readJson(path.join(ROOT, lane.dataRoot, 'shorts', 'uploads.json'), {})[sid];
    if (!story || !entry?.videoId) { logger.error(`no uploaded story "${sid}" in ${laneName}`); process.exit(1); }
    sequelOf = { ...story, videoId: entry.videoId, url: entry.url };
  }
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
  const pinned = opt('--article')
    ? { article: opt('--article'), subject: opt('--subject') || opt('--article').replace(/\([^)]*\)/g, '').trim(), moment: opt('--moment'), title: opt('--title') }
    : null;
  if (pinned && (!pinned.moment || !pinned.title)) { logger.error('--article needs --moment and --title'); process.exit(1); }
  const seriesDue = args.includes('--series')
    ? seriesPartDue(LANES.find((l) => l.name.toLowerCase() === String(laneName).toLowerCase()) || {})
    : null;
  if (args.includes('--series') && !seriesDue) { logger.error(`no series part due on ${laneName}`); process.exit(1); }
  // --series-part <key>:<n> renders one named part whatever is due, for the
  // cloud preview (preview-short.yml); the link back to Part n-1 is a stand-in.
  let pickedPart = null;
  if (opt('--series-part')) {
    const [key, num] = String(opt('--series-part')).split(':');
    const s = SERIES.find((x) => x.key === key);
    const n = Number(num);
    if (!s || !s.parts[n - 1]) { logger.error(`no series part "${opt('--series-part')}"`); process.exit(1); }
    pickedPart = { series: s, part: s.parts[n - 1], n, prev: n > 1 ? { id: partId(s, n - 1), videoId: 'PREVIEW' } : null };
  }
  makeStoryShort(laneName, { dryRun: args.includes('--dry-run'), sequelOf, story: pinned, seriesDue: pickedPart || seriesDue, rerender: Boolean(pickedPart) })
    .then((r) => console.log(JSON.stringify({ ...r, text: r.text ? `${r.text.slice(0, 400)}…` : undefined }, null, 2)))
    .catch((e) => { logger.error(`story-short failed: ${e.message}`); process.exit(1); });
}

module.exports = { makeStoryShort, hookProblem, renderStills, chooseStyle, unsupportedSentences, parseJson, trending, seriesBrief, seriesPhotos };
