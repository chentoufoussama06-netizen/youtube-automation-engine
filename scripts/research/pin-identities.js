#!/usr/bin/env node
/**
 * Pin a Wikidata QID to every queue topic.
 *
 *   node scripts/pin-identities.js --propose      # decision sheet, writes nothing to the queue
 *   node scripts/pin-identities.js --set ibrox=Q14756553 --type ibrox=event
 *   node scripts/pin-identities.js --cut mh370 --why "belongs to neither channel"
 *   node scripts/pin-identities.js --audit        # what is pinned, what is blocked
 *
 * Why the pin is a HUMAN act and this script only proposes:
 *
 * Resolving identity from keywords is what broke. `keywords[0]` for the Ibrox
 * disaster is "Ibrox", which resolves to Q208709 — the stadium. Narration
 * written from that article then invented "Stairway 13", because a stadium
 * article has no crush in it to draw on. "Port Said" resolved to the city,
 * "MH370" to a conspiracy book. Each of those is a perfectly reasonable top hit
 * for its search term, so no ranking tweak fixes it: the search term itself is
 * the bug.
 *
 * So the machine offers candidates with their descriptions and the properties
 * that distinguish an event item from a venue, and a person decides. Once
 * pinned, the QID is the anchor — no anchor, no build.
 *
 * WHAT --propose PRODUCES: one sheet, four decisions per topic — QID, type,
 * channel, keep/cut — with a recommendation already filled in and every
 * rejected candidate named with the rule it broke. Candidates run through
 * checkIdentity(), the SAME rulebook verify-claims.js applies afterwards, so a
 * topic cannot pass the pin and then be blocked by the identity it was just
 * pinned to.
 */

require('dotenv').config();

const fsp = require('fs').promises;
const path = require('path');
const {
  pinIdentity, searchWikipediaQids, fetchEntity, labelsFor, checkIdentity, normalizeDate, PLACE_CLASSES
} = require('../../utils/source-layer');

/** Fold a string for comparison: accents off, punctuation out, lower case. */
const norm = (s) => String(s || '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^\w\s]/g, ' ')
  .toLowerCase().trim();
const { isBuildable, LANES: LANE_LIST } = require('../../utils/lanes');
const { Logger } = require('../../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const DATA_ROOT = process.env.DATA_ROOT || 'data';
const QUEUE_PATH = path.join(ROOT, DATA_ROOT, 'queue.json');
const WORKLIST = path.join(ROOT, DATA_ROOT, 'identity-worklist.md');
const CACHE_PATH = path.join(ROOT, DATA_ROOT, 'identity-candidates.json');
const CORRECTIONS_PATH = path.join(ROOT, DATA_ROOT, 'corrections.json');
const BRIEF_DIR = path.join(ROOT, 'data', 'research', 'briefs');
const logger = new Logger('PinIdentities');

const TYPES = new Set(['person', 'event', 'place', 'thing']);
const LANES = new Set(LANE_LIST);

// Q4167410 disambiguation page · Q13406463 list article · Q4167836 category.
const WIKIMEDIA_SCAFFOLD = new Set(['Q4167410', 'Q13406463', 'Q4167836']);

/** Wikidata is generous with requests and quick to throttle. Pace it. */
const pace = (ms = 1100) => new Promise((r) => setTimeout(r, ms));

/**
 * Topics already decided by the user, for reasons no property can express.
 * Named here rather than quietly dropped, so the sheet says WHY.
 */
const DECIDED_CUTS = {
  mh370: 'belongs to neither channel — decided by the user'
};

/**
 * Guess the type from how the topic is phrased — a starting point for review,
 * never the decision. "The death of X" is a person story; "The X disaster" is
 * an event.
 */
function guessType(topic) {
  // The person test runs FIRST, and "collapse of" is not an event phrase.
  //
  // With the event test first, "The collapse of Christian Eriksen" matched
  // "collapse of" and was typed `event` — then failed the P585 rule, because a
  // living footballer has no point in time, and was recommended for cutting.
  // Eriksen, Muamba and Nouri all collapsed and all survived; they are person
  // stories. An event that actually is one says disaster, fire, crash, riot.
  if (/\b(?:death|collapse|murder|disappearance|last match|last weekend) of\b/i.test(topic)) return 'person';
  if (/\b(disaster|fire|crash|collision|riot|stampede|sinking|scandal|ruling)\b/i.test(topic)) return 'event';
  return 'thing';
}

/** Is this topic about someone dying? Decides whether P570 is required. */
function isDeathTopic(entry) {
  return /\b(death|died|killed|murder|fatal|last match|last weekend)\b/i.test(
    `${entry.topic} ${entry.angle || ''}`
  );
}

/**
 * The year the topic is about.
 *
 * Priority matters: the topic title is deliberate, the keywords are curated,
 * and the angle is prose that names other years in passing. Taking the first
 * year out of the angle would auto-reject correct QIDs.
 */
function topicYear(entry) {
  const YEAR = /\b(1[89]\d\d|20\d\d)\b/;
  for (const field of [entry.topic, (entry.keywords || []).join(' '), entry.angle || '']) {
    const m = YEAR.exec(String(field));
    if (m) return m[1];
  }
  return null;
}

// Wikidata occupation and sport LABELS, not QIDs. "association football player"
// and "basketball player" say what they are; a hand-copied QID can be wrong and
// look right, which is the whole reason this layer exists.
const FOOTBALL_LABEL = /association football|footballer|football manager|football club/i;
const OTHER_SPORT_LABEL = /basketball|racing|motorsport|wrestl|box(?:er|ing)|cricket|rugby|ice hockey|baseball|tennis|athletics|cycling|golf|american football/i;

// Prose fallback for topics whose entity carries no sport property at all —
// an air disaster has no P106. On a football channel, club names are nouns.
const FOOTBALL_TEXT = new RegExp([
  'football', 'soccer', 'fifa', 'uefa', 'premier league', 'serie a', 'la liga',
  'bundesliga', 'stadium', 'stadion', 'estadio', 'pitch', 'midfielder', 'striker',
  'goalkeeper', 'defender', 'full.?back', 'winger', 'terrace', 'old firm',
  'cup final', 'confederations cup', 'copa libertadores', 'champions league',
  'world cup', 'benfica', 'ajax', 'sevilla', 'torino', 'tottenham', 'atl[eé]tico',
  'celtic', 'rangers', 'juventus', 'feyenoord', 'nantes', 'leicester',
  'european court of justice'
].join('|'), 'i');

const OTHER_SPORT_TEXT = new RegExp([
  'nascar', 'daytona', 'formula one', 'grand prix', '\\bf1\\b', 'imola',
  '\\bnba\\b', 'basketball', 'celtics', 'lakers', 'loyola marymount', '\\bncaa\\b',
  'wrestling', '\\bwwf\\b', '\\bwwe\\b', 'boxing', 'cricket', 'rugby', 'olympic'
].join('|'), 'i');

/**
 * Which editorial LANE a topic belongs to.
 *
 * The channel's lane is "deaths, disasters and scandals in sport", with
 * football as the centre of gravity. That is a quota, not a vibe: `football` is
 * the default lane and `sport_wide` is capped on the publish side.
 *
 * Lanes replace the old channel heuristic, which produced a real artifact —
 * Hank Gathers passed as "sport" because his entity is a person carrying
 * P106 basketball player, while Kobe Bryant was cut because his best candidate
 * was a crash event carrying no sport property at all. Same sport, opposite
 * outcomes, decided by which kind of thing got pinned. A schema fixes that once
 * instead of arguing it case by case.
 *
 * `sportLabels` are the resolved P106/P641 labels of the chosen candidate and
 * outrank the prose: Kobe's angle never says "basketball", but his entity does.
 */
function laneFor(entry, sportLabels = []) {
  const labels = sportLabels.filter(Boolean).join(' ');
  const text = `${entry.topic} ${entry.angle || ''} ${(entry.keywords || []).join(' ')}`;

  if (FOOTBALL_LABEL.test(labels) || FOOTBALL_TEXT.test(text)) {
    return { lane: 'football', reason: 'football subject' };
  }
  if (OTHER_SPORT_LABEL.test(labels) || OTHER_SPORT_TEXT.test(text)) {
    return { lane: 'sport_wide', reason: 'sport, not football — capped at 1 in 5 uploads' };
  }
  return { lane: null, reason: 'not a sport subject — outside the lane' };
}

/**
 * Run one candidate through the acceptance rules for its type.
 *
 * The hard rules come from checkIdentity() so that pin time and verify time
 * agree. The extras here are the ones that only matter while choosing BETWEEN
 * candidates: a death topic whose QID carries no date of death, and a label
 * with nothing to do with the topic.
 */
function acceptCandidate(entity, { type, entry, year, briefText }) {
  if (!entity) return { ok: false, score: 0, rejects: ['could not fetch entity'] };

  const check = checkIdentity(entity, { topicType: type, briefText, topicLabel: entry.topic });
  const rejects = [...check.problems];

  // Wikimedia scaffolding is never a subject. A disambiguation page carries a
  // plausible label and nothing behind it — "Ibrox disaster" is one, and so is
  // "Mateo Flores", which tied with the real disaster item on score.
  if (entity.instanceOf.some((i) => WIKIMEDIA_SCAFFOLD.has(i))) {
    rejects.push('Wikimedia disambiguation or list page, not a subject');
  }
  let score = check.ok ? 2 : 0;

  const label = String(entity.label || '').toLowerCase();
  const haystack = `${entry.topic} ${(entry.keywords || []).join(' ')}`.toLowerCase();
  // Pure numbers are excluded: "2006 FIFA World Cup Final" shared the token
  // "2006" with Calciopoli's keywords and passed the name-overlap rule that
  // exists precisely to stop a year standing in for an identity.
  const labelHit = Boolean(label) && label.split(/\s+/)
    .filter((w) => w.length > 3 && !/^\d+$/.test(w))
    .some((w) => haystack.includes(w));
  if (labelHit) score += 1;

  if (type === 'person') {
    // P570 is required only when the story IS a death. Eriksen, Muamba and
    // Nouri all collapsed and survived — demanding a date of death there would
    // auto-reject the correct human, and finding one would be the red flag.
    if (isDeathTopic(entry)) {
      if (!entity.deathDate.length) rejects.push('no P570 date of death, but the topic is a death');
      else {
        score += 1;
        const dYear = (/([+-]\d{4})/.exec(entity.deathDate[0]) || [])[1]?.replace('+', '');
        if (year && dYear && dYear !== year) rejects.push(`P570 year ${dYear} != topic year ${year}`);
        else if (dYear) score += 1;
      }
    }
  }

  if (type === 'event') {
    // The AUTO-REJECT rule, stated against the topic's own year rather than
    // years scraped out of the brief. The Furiani-class failure dies here.
    const pYear = (/([+-]\d{4})/.exec(entity.pointInTime[0] || '') || [])[1]?.replace('+', '');
    if (year && pYear && pYear !== year) rejects.push(`P585 year ${pYear} != topic year ${year} — AUTO-REJECT`);
    else if (year && pYear) score += 2;
    if (entity.deaths.length) score += 1;
    if (entity.location.length) score += 1;
  }

  if (type === 'place' && !labelHit) rejects.push('label does not appear in the topic or its keywords');

  // An event must share a NAME with its topic TITLE, not just a year and not
  // merely a word from the keywords.
  //
  // "2006 FIFA World Cup Final" scored 5/5 against "The Calciopoli match-fixing
  // scandal" on the shared token "2006". "capital punishment in Egypt" then
  // scored 4/5 against "The Port Said stadium disaster", because "Egypt" is in
  // that topic's keywords for unrelated reasons. A country is not an identity
  // either. Titles name the event, so titles are what must overlap: "Armand
  // Cesari Stadium disaster" shares stadium and disaster, "Stampede in
  // Luzhniki" shares Luzhniki.
  const titleWords = norm(entry.topic).split(/\s+/);
  const titleHit = Boolean(label) && label.split(/\s+/)
    .map(norm)
    .filter((w) => w.length > 3 && !/^\d+$/.test(w))
    .some((w) => titleWords.includes(w));

  if (type === 'event') {
    if (!titleHit) rejects.push('label shares no word with the topic title — a matching year or country is not an identity');
    // An event pinned to its venue is the original Ibrox failure in miniature:
    // the stadium article has no disaster in it to write from.
    if (entity.instanceOf.some((i) => PLACE_CLASSES.has(i))) {
      rejects.push('this is a venue, not an event');
    }
  }

  return { ok: rejects.length === 0, score: rejects.length ? 0 : score, rejects };
}

/**
 * Search strings to hunt candidates with, best first.
 *
 * Searching Wikidata with the topic title finds nothing: "death of
 * Marc-Vivien Foe" is a sentence, and Wikidata labels are names. The subject
 * has to be dug out of the phrasing — and for events, Wikidata's own naming
 * convention puts the year first ("1971 Ibrox disaster"), which is usually an
 * exact label hit.
 *
 * Using keywords[0] as a QUERY is not the retired behaviour. What was retired
 * was keywords[0] as the ANCHOR, unreviewed — "Ibrox" resolving straight to the
 * stadium. Here it only proposes a candidate that a human then accepts or
 * rejects against the type rules, which is what it was always fit for.
 */
function queriesFor(entry, type, year) {
  const topic = entry.topic.replace(/^The\s+/i, '').trim();
  const bare = topic.replace(/^(?:death|collapse|murder|disappearance|sinking|last match|last weekend)\s+of\s+/i, '');
  const noYear = bare.replace(/\s+of\s+(?:1[89]\d\d|20\d\d)$/i, '').trim();
  const kw = (entry.keywords || [])[0];
  const eventWord = (/(disaster|fire|crash|collision|collapse|riot|stampede|sinking|scandal|ruling|murder)/i
    .exec(entry.topic) || [])[1];

  const out = [];
  const add = (q) => {
    const s = String(q || '').trim();
    if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  };

  if (type === 'person') {
    add(kw);
    add(bare);
  } else {
    // Only prefix the year when the title does not already carry it, or
    // "The 1964 Estadio Nacional disaster" searches for "1964 1964 Estadio...".
    if (year && noYear && !noYear.includes(year)) add(`${year} ${noYear}`);
    add(noYear);
    if (kw && eventWord) add(`${kw} ${eventWord}`);
    add(kw);
  }
  add(topic);
  return out.slice(0, 4);
}

/** The properties that tell an event from a venue, and a man from a monument. */
function signals(entity) {
  if (!entity) return 'could not fetch';
  const day = (t) => normalizeDate(String(t).slice(1, 11)) || String(t).slice(1, 11);
  const bits = [];
  if (entity.pointInTime.length) bits.push(`P585 ${day(entity.pointInTime[0])}`);
  if (entity.deathDate.length) bits.push(`P570 ${day(entity.deathDate[0])}`);
  if (entity.deaths.length) bits.push(`P1120 ${entity.deaths[0]} deaths`);
  if (entity.location.length) bits.push(`P276 ${entity.location[0]}`);
  if (entity.occupations.length) bits.push(`P106 ${entity.occupations.slice(0, 2).join(',')}`);
  if (entity.instanceOf.length) bits.push(`P31 ${entity.instanceOf.slice(0, 2).join(',')}`);
  return bits.join(' · ') || 'no distinguishing properties';
}

/**
 * Candidates already fetched from Wikidata, so a restart is cheap.
 *
 * The pass costs roughly a minute per topic once Wikidata starts asking for
 * 40-second backoffs, and this machine has killed long runs for memory before.
 * Losing thirty minutes of throttle budget to an OOM at topic 28 is not a risk
 * worth carrying, so every topic's raw candidates are written to disk as soon
 * as they arrive. Only the FETCH is cached — the acceptance rules are re-run
 * from the cached entities every time, so tightening a rule never needs a
 * re-fetch.
 */
const loadCache = () => fsp.readFile(CACHE_PATH, 'utf8').then(JSON.parse).catch(() => ({}));
const saveCache = (cache) => fsp.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2));

/**
 * The corrections log — the engine's own output, audited.
 *
 * The engine is allowed to fix its own proposals before the sheet reaches a
 * human. That freedom is only safe if every such fix is visible, so each one is
 * recorded before -> after -> why, and surfaced in the digest.
 *
 * The precedent is the gate-drop log: the death-lexicon gate only earned trust
 * once it had to show what it refused. An engine that silently revises itself
 * is a worse version of the same problem, because the thing being revised is
 * the recommendation a human is about to ratify.
 */
async function logCorrections(entries) {
  if (!entries.length) return;
  const log = await fsp.readFile(CORRECTIONS_PATH, 'utf8').then(JSON.parse).catch(() => ({ entries: [] }));
  log.entries.push(...entries);
  await fsp.writeFile(CORRECTIONS_PATH, JSON.stringify(log, null, 2));
  for (const c of entries) {
    logger.warn(`CORRECTION ${c.topic_id} ${c.field}: ${c.before} -> ${c.after} (${c.reason})`);
  }
}

/** What changed between the last proposal for a topic and this one. */
function correctionsFor(row, previous) {
  if (!previous) return [];
  const now = { entity_qid: row.best?.qid || null, topic_type: row.type, lane: row.lane };
  const out = [];
  for (const [field, after] of Object.entries(now)) {
    const before = previous[field] ?? null;
    if (before === after || before === null) continue;

    // The reason is derived, never narrated: it is what the superseded
    // candidate now trips, or the plain fact that it stopped qualifying.
    const stale = row.candidates.find((c) => c.qid === before);
    const reason = field === 'entity_qid' && stale?.rejects?.length
      ? stale.rejects.join('; ')
      : `superseded on re-run (${field} no longer ${before})`;
    out.push({
      at: new Date().toISOString(), source: 'pin-identities',
      topic_id: row.id, field, before, after, reason
    });
  }
  return out;
}

/** Invalidates a cached entry when the topic itself changes. */
const signatureOf = (t, type) => `v3|${t.topic}|${(t.keywords || []).join(',')}|${type}`;

/** Everything known about one topic, before any of it is written down. */
async function assess(t, cache = {}) {
  const type = t.topic_type || guessType(t.topic);
  const year = topicYear(t);
  const brief = await fsp.readFile(path.join(BRIEF_DIR, `${t.id}.json`), 'utf8')
    .then(JSON.parse).catch(() => null);
  // Candidates are judged against the TOPIC, never against the cached brief.
  //
  // The brief is what the pin exists to replace, and before a pin exists it may
  // be about the wrong subject entirely — zamalek's cached brief is the article
  // for the city of Port Said, so the correct "Port Said Stadium riot" was
  // rejected for having a 2012 date the city's history does not mention, and
  // the stadium won by carrying no date to contradict. Using an unverified
  // brief to verify identity is circular. The brief is checked later, by
  // verify-claims, against the pin it must match.
  const briefText = `${t.topic} ${t.angle || ''} ${(t.keywords || []).join(' ')}`;

  // The channel is decided in propose(), once every entity's occupation and
  // sport QIDs can be resolved to labels in a single batched call.
  const row = {
    id: t.id, entry: t, topic: t.topic, type, year, lane: null, laneReason: null,
    brief: brief?.title || null, pinned: t.entity_qid || null,
    candidates: [], searchNotes: [], best: null, cut: DECIDED_CUTS[t.id] || null,
    deferred: null, throttled: false, confidence: 0
  };
  if (row.cut) return row;

  // Gather candidates across every query, deduped by QID. A failure here is
  // RECORDED, never swallowed: an empty catch once turned "Wikidata found
  // nothing" into a confident recommendation to cut all 32 topics.
  const queries = queriesFor(t, type, year);
  const seen = new Map();

  // A cached entry is reused only if it is complete: a throttled entry is a
  // half-answer, and reusing one would make the throttle permanent.
  const hit = cache[t.id];
  if (hit && hit.sig === signatureOf(t, type) && !hit.throttled) {
    for (const c of hit.candidates) seen.set(c.qid, c);
    row.searchNotes.push(`reused ${hit.candidates.length} cached candidate(s) from ${hit.at.slice(0, 16)}`);
  }

  // Two indexes, because they fail on opposite things. Wikidata's label search
  // nails a person's name; Wikipedia's full-text search is the only one that
  // finds a descriptive title like "Furiani disaster" (which Wikidata answers
  // with the commune of Furiani). Wikipedia goes first for that reason.
  for (const [qi, q] of (seen.size ? [] : queries).entries()) {
    if (seen.size >= 6) break;

    for (const [name, lookup] of [['wikipedia', searchWikipediaQids], ['wikidata', pinIdentity]]) {
      // The first query always asks BOTH indexes. Breaking between them let
      // Wikipedia's four hits fill the list and Wikidata never ran, which is
      // how "Calciopoli" lost to the 2006 World Cup Final.
      if (qi > 0 && seen.size >= 6) break;
      try {
        const found = await lookup(q);
        const list = Array.isArray(found)
          ? found
          : found
            ? [{ qid: found.qid, label: found.label, description: found.description }, ...found.alternatives]
            : [];
        if (!list.length) row.searchNotes.push(`"${q}" — no ${name} match`);
        for (const c of list) {
          if (!seen.has(c.qid)) seen.set(c.qid, { qid: c.qid, label: c.label, description: c.description, query: `${name}:${q}` });
        }
      } catch (error) {
        if (error.name === 'RateLimited') row.throttled = true;
        row.searchNotes.push(`"${q}" — ${name} failed: ${String(error.message).slice(0, 60)}`);
      }
      await pace();
    }
  }

  for (const c of [...seen.values()].slice(0, 6)) {
    let ent = c.entity ?? null;
    if (!ent) {
      try { ent = await fetchEntity(c.qid); } catch (error) {
        if (error.name === 'RateLimited') row.throttled = true;
        row.searchNotes.push(`${c.qid} — fetch failed: ${String(error.message).slice(0, 60)}`);
      }
      await pace();
    }
    row.candidates.push({ ...c, entity: ent, ...acceptCandidate(ent, { type, entry: t, year, briefText }) });
  }

  // Written per topic, not at the end, so a kill at topic 28 keeps 27 topics.
  // The previous proposal is carried forward deliberately: it is what the
  // corrections log compares against, and overwriting it here would erase the
  // evidence that the engine changed its own mind.
  cache[t.id] = {
    at: new Date().toISOString(),
    sig: signatureOf(t, type),
    proposed: cache[t.id]?.proposed || null,
    queries,
    throttled: row.throttled,
    candidates: row.candidates.map((c) => ({
      qid: c.qid, label: c.label, description: c.description, query: c.query, entity: c.entity
    }))
  };

  const passing = row.candidates.filter((c) => c.ok).sort((a, b) => b.score - a.score);
  row.best = passing[0] || null;
  row.confidence = row.best ? Math.min(5, row.best.score) : 0;
  // No clean candidate is not a reason to force an anchor — it is a cut.
  //
  // A throttle is not a finding. Wikidata answering 429 looks exactly like a
  // subject that does not exist, and reading it as one recommended cutting 30
  // real topics — Emiliano Sala among them. Throttled topics are DEFERRED.
  if (!row.best) {
    if (row.throttled) {
      row.deferred = 'Wikidata rate-limited this topic — re-run, do not cut';
    } else {
      row.cut = row.candidates.length
        ? 'no candidate QID passed its type rules'
        : `no Wikidata candidate found (tried: ${queries.map((q) => `"${q}"`).join(', ')})`;
    }
  }
  return row;
}

async function propose(topics) {
  const cache = await loadCache();
  const cached = topics.filter((t) => cache[t.id] && !cache[t.id].throttled).length;
  if (cached) logger.info(`${cached}/${topics.length} topic(s) already cached — only the rest hit Wikidata`);

  const rows = [];
  for (const [i, t] of topics.entries()) {
    const row = await assess(t, cache);
    await saveCache(cache);
    rows.push(row);
    const mark = row.deferred ? 'DEFERRED (throttled)' : row.cut ? 'CUT' : `pin ${row.best.qid} (${row.confidence}/5)`;
    logger.info(`[${i + 1}/${topics.length}] ${t.id.padEnd(15)} ${row.type.padEnd(7)} ${mark}`);
  }

  // One batched label lookup serves both the readable property lines and the
  // channel decision, so the whole sheet costs a single extra request.
  const names = await labelsFor(rows.flatMap((r) => r.candidates)
    .flatMap((c) => [...(c.entity?.instanceOf || []).slice(0, 2), ...(c.entity?.occupations || []).slice(0, 2),
      ...(c.entity?.sports || []).slice(0, 1), ...(c.entity?.location || []).slice(0, 1)]));
  const named = (s) => String(s).replace(/Q\d+/g, (m) => names[m] || m);

  for (const r of rows) {
    const e = r.best?.entity;
    const sportLabels = [...(e?.occupations || []), ...(e?.sports || [])].map((q) => names[q]);
    // A lane already set by hand in the queue wins — the schema is the
    // decision, and the heuristic only proposes where none has been made.
    const proposed = laneFor(r.entry, sportLabels);
    r.lane = r.entry.lane || proposed.lane;
    r.laneReason = r.entry.lane ? 'set in the queue' : proposed.reason;
    if (!r.cut && !r.deferred && !r.lane) r.cut = proposed.reason;
  }

  // Item 6 — the engine may fix its own proposals, but never quietly.
  const corrections = rows.flatMap((r) => correctionsFor(r, cache[r.id]?.proposed));
  await logCorrections(corrections);
  for (const r of rows) {
    if (cache[r.id]) {
      cache[r.id].proposed = { entity_qid: r.best?.qid || null, topic_type: r.type, lane: r.lane };
    }
  }
  await saveCache(cache);

  // Persons first, then by confidence — the strongest, most recognisable
  // identities get read while attention is freshest.
  const ORDER = { person: 0, event: 1, place: 2, thing: 3 };
  const keep = rows.filter((r) => !r.cut && !r.deferred)
    .sort((a, b) => (ORDER[a.type] - ORDER[b.type]) || (b.confidence - a.confidence));
  const cut = rows.filter((r) => r.cut);
  const deferred = rows.filter((r) => r.deferred);

  const L = ['# Identity worklist — one pass, four decisions per topic', '',
    `${keep.length} to pin · ${cut.length} recommended CUT · ${deferred.length} deferred · generated ${new Date().toISOString().slice(0, 10)}`, '',
    'Every topic carries a recommendation. Change any of the four decisions before',
    'running the commands at the bottom. Rejected candidates are listed with the',
    'rule they broke, so a wrong recommendation is visible rather than silent.', ''];

  for (const [i, r] of keep.entries()) {
    L.push(`## ${i + 1}. ${r.id} — ${r.topic}`, '');
    L.push('| decision | value |', '|---|---|');
    L.push(`| **QID** | \`${r.best.qid}\` ${r.best.label} |`);
    L.push(`| **type** | ${r.type}${r.year ? ` · topic year ${r.year}` : ' · no year in topic'} |`);
    L.push(`| **lane** | \`${r.lane}\` — ${r.laneReason} |`);
    L.push(`| **keep/cut** | KEEP · confidence ${r.confidence}/5 |`);
    L.push('');
    L.push(`- \`${r.best.qid}\` **${r.best.label}** — ${r.best.description || 'no description'}`);
    L.push(`  - ${named(signals(r.best.entity))}`);
    if (r.brief) L.push(`  - cached brief: *${r.brief}*`);
    if (r.pinned && r.pinned !== r.best.qid) L.push(`  - ⚠ ALREADY PINNED to ${r.pinned} — applying this would change it`);
    const rejected = r.candidates.filter((c) => !c.ok);
    if (rejected.length) {
      L.push('  - rejected:');
      for (const c of rejected) L.push(`    - \`${c.qid}\` ${c.label} — ${c.rejects.join('; ')}`);
    }
    L.push('');
  }

  if (deferred.length) {
    L.push('## Deferred — Wikidata throttled, NOT a verdict', '',
      'These are not decisions. Re-run `--propose` and they will resolve.', '');
    for (const r of deferred) L.push(`- **${r.id}** — ${r.topic}`);
    L.push('');
  }

  if (cut.length) {
    L.push('## Recommended CUT', '');
    for (const r of cut) L.push(`- **${r.id}** — ${r.topic}  \n  ${r.cut}`);
    L.push('');
  }

  L.push('## Apply', '', '```bash');
  if (keep.length) {
    L.push('node scripts/pin-identities.js \\');
    keep.forEach((r, i) => {
      L.push(`  --set ${r.id}=${r.best.qid} --type ${r.id}=${r.type} --lane ${r.id}=${r.lane}${i === keep.length - 1 ? '' : ' \\'}`);
    });
  }
  if (cut.length) L.push('', `node scripts/pin-identities.js --cut ${cut.map((r) => r.id).join(',')}`);
  L.push('```', '');

  await fsp.writeFile(WORKLIST, L.join('\n'));
  logger.success(`${keep.length} to pin, ${cut.length} to cut, ${deferred.length} deferred -> ${WORKLIST}`);
  if (deferred.length) logger.warn(`${deferred.length} topic(s) were rate-limited, not judged. Re-run --propose.`);
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const get = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
  const queue = JSON.parse(await fsp.readFile(QUEUE_PATH, 'utf8'));
  const topics = queue.topics.filter(isBuildable);

  if (args.includes('--propose')) return propose(topics);

  if (args.includes('--audit')) {
    let pinned = 0;
    for (const t of topics) {
      const brief = await fsp.readFile(path.join(BRIEF_DIR, `${t.id}.json`), 'utf8')
        .then(JSON.parse).catch(() => null);
      const state = t.entity_qid ? `${t.entity_qid} (${t.topic_type || 'no type'})` : 'UNPINNED — build blocked';
      if (t.entity_qid) pinned++;
      logger.info(`  ${t.id.padEnd(14)} ${state.padEnd(28)} brief: ${brief?.title || 'none'}`);
    }
    const cutCount = queue.topics.filter(t => t.status === 'cut').length;
    logger.info('');
    logger.info(`${pinned}/${topics.length} pinned. Unpinned topics cannot be built — the pin is the anchor.`);
    if (cutCount) logger.info(`${cutCount} topic(s) cut and excluded.`);
    return null;
  }

  // --set id=QID  --type id=event  --cut id[,id]   (all repeatable)
  const sets = args.filter((a, i) => args[i - 1] === '--set');
  const types = args.filter((a, i) => args[i - 1] === '--type');
  const cuts = args.filter((a, i) => args[i - 1] === '--cut').flatMap((a) => a.split(','));
  const lanes = args.filter((a, i) => args[i - 1] === '--lane');
  if (!sets.length && !types.length && !cuts.length && !lanes.length) {
    throw new Error('usage: --propose | --audit | --set <id>=<QID> [--type <id>=<person|event|place|thing>]'
      + ' [--lane <id>=<football|sport_wide>] | --cut <id>');
  }

  for (const pair of lanes) {
    const [id, lane] = pair.split('=');
    const t = queue.topics.find(x => x.id === id);
    if (!t) { logger.warn(`no topic "${id}"`); continue; }
    if (!LANES.has(lane)) { logger.warn(`"${lane}" is not a lane`); continue; }
    t.lane = lane;
    logger.info(`${id} lane ${lane}`);
  }

  for (const pair of sets) {
    const [id, qid] = pair.split('=');
    const t = queue.topics.find(x => x.id === id);
    if (!t) { logger.warn(`no topic "${id}"`); continue; }
    if (!/^Q\d+$/.test(qid || '')) { logger.warn(`"${qid}" is not a QID`); continue; }
    t.entity_qid = qid;
    logger.info(`${id} -> ${qid}`);
  }

  for (const pair of types) {
    const [id, type] = pair.split('=');
    const t = queue.topics.find(x => x.id === id);
    if (!t) { logger.warn(`no topic "${id}"`); continue; }
    if (!TYPES.has(type)) { logger.warn(`"${type}" is not a topic_type`); continue; }
    t.topic_type = type;
    logger.info(`${id} type ${type}`);
  }

  // A cut is reversible on purpose: the row stays, with a reason and a date, so
  // "why isn't this building?" still has an answer six weeks from now.
  const why = get('--why') || 'cut during the identity pass';
  for (const id of cuts.filter(Boolean)) {
    const t = queue.topics.find(x => x.id === id);
    if (!t) { logger.warn(`no topic "${id}"`); continue; }
    t.status = 'cut';
    t.cutReason = why;
    t.cutAt = new Date().toISOString();
    logger.info(`${id} CUT — ${why}`);
  }

  await fsp.writeFile(QUEUE_PATH, JSON.stringify(queue, null, 2));
  logger.success(`queue updated -> ${QUEUE_PATH}`);
  return null;
}

if (require.main === module) {
  main().catch(error => {
    logger.error(`pin-identities failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { guessType, topicYear, laneFor, acceptCandidate, isDeathTopic, queriesFor, LANES };
