/* global fetch, AbortSignal, URLSearchParams */
// SOURCE LAYER v1 — pin the subject, extract claims, verify them, block renders.
//
// The failure this exists for: a narration named "Stairway 13" and two earlier
// crushes, drawn from a Wikipedia article that never mentions stairs. Checking
// the text against the brief was not enough, because the brief itself can be
// the wrong subject — "Ibrox" returned the stadium, "Port Said" the city,
// "MH370" a conspiracy book. A claim can be copied perfectly out of a source
// that is about something else entirely.
//
// Two deliberate choices, both of which cost recall on purpose:
//
// 1. CLAIMS ARE EXTRACTED BY REGEX, NOT BY A MODEL. If the model decides what
//    the claims are, it can quietly omit the one it invented and the layer
//    certifies nothing. Deterministic extraction misses some real claims; it
//    never hides one.
//
// 2. MATCHING IS EXACT, NOT SEMANTIC. "66 died" matches "66 dead" because the
//    value is the same token. It does NOT match "sixty-six fatalities", and it
//    is not meant to — a fuzzy matcher that calls those equal will eventually
//    call "66 injured" equal too, and a false PASS is worse than no check at
//    all, because it launders an unverified claim as verified.
//
// Everything ambiguous routes to HUMAN. This narrows what has to be read; it
// does not replace the reading.

const { Logger } = require('./logger');

const logger = new Logger('SourceLayer');
const UA = 'youtube-automation-agent/1.0 (documentary fact verification)';

/* -- one retry policy for every Wikidata call ------------------------------ */

/**
 * Wikidata, with backoff.
 *
 * A 429 is not an answer. Without this, a throttled search returned nothing and
 * the identity pass read that as "this subject does not exist on Wikidata" —
 * recommending that 30 real topics be cut, Emiliano Sala among them. Same shape
 * as the Wayback "0 captured" scare: a refusal to answer must never be reported
 * as a finding.
 *
 * Anonymous use is about one request a second sustained, so callers pace too;
 * this handles the bursts that slip past that.
 */
class RateLimited extends Error {
  constructor(status) {
    super(`rate limited by Wikidata (HTTP ${status})`);
    this.name = 'RateLimited';
    this.status = status;
  }
}

// Used for Wikidata and for Wikipedia's search index, which throttles the same
// way and deserves the same patience.
async function wdFetch(url, { attempts = 4 } = {}) {
  let wait = 2000;
  for (let i = 1; i <= attempts; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000) });
    if (res.ok) return res.json();
    if (res.status !== 429 && res.status !== 503) throw new Error(`Wikidata HTTP ${res.status}`);
    if (i === attempts) throw new RateLimited(res.status);
    const retryAfter = Number(res.headers.get('retry-after'));
    const pause = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : wait;
    logger.warn(`Wikidata ${res.status} — backing off ${Math.round(pause / 1000)}s (attempt ${i}/${attempts})`);
    await new Promise((r) => setTimeout(r, pause));
    wait = Math.min(wait * 2.5, 30000);
  }
  throw new RateLimited(429);
}

/* ── identity ──────────────────────────────────────────────────────────── */

/**
 * Pin the subject to a Wikidata QID.
 *
 * A QID is what an article title is not: stable, unambiguous, and never shared
 * between a man and a city. Pinning it at queue time is what keeps Pablo
 * Escobar out of a story about Andres Escobar.
 */
async function pinIdentity(query) {
  const url = 'https://www.wikidata.org/w/api.php?'
    + new URLSearchParams({ action: 'wbsearchentities', search: query, language: 'en', format: 'json', limit: '5' });

  const data = await wdFetch(url);
  const hits = data.search || [];
  if (!hits.length) return null;

  const top = hits[0];
  return {
    qid: top.id,
    label: top.label,
    description: top.description || null,
    alternatives: hits.slice(1, 4).map(h => ({ qid: h.id, label: h.label, description: h.description }))
  };
}

/**
 * Candidates via Wikipedia's full-text index, mapped back to QIDs.
 *
 * wbsearchentities matches Wikidata LABELS, near enough to a prefix match. That
 * is fine for "Marc-Vivien Foe" and useless for a descriptive title: "Furiani
 * disaster" returns the commune of Furiani, "Port Said stadium disaster"
 * returns the city, and the identity pass then reports a real topic as having
 * no Wikidata item at all. Wikipedia's search finds those articles instantly,
 * and every article carries its QID — so search the index that works, then come
 * back to Wikidata for the properties.
 */
async function searchWikipediaQids(query, limit = 4) {
  const searchUrl = 'https://en.wikipedia.org/w/api.php?'
    + new URLSearchParams({ action: 'query', list: 'search', srsearch: query,
      srlimit: String(limit), format: 'json', origin: '*' });

  // Backs off like every other call here. Throwing on the first 429 is how a
  // throttle gets recorded as "no such subject".
  const titles = (((await wdFetch(searchUrl)).query?.search) || []).map((h) => h.title).filter(Boolean);
  if (!titles.length) return [];

  const mapUrl = 'https://www.wikidata.org/w/api.php?'
    + new URLSearchParams({ action: 'wbgetentities', sites: 'enwiki', titles: titles.join('|'),
      props: 'labels|descriptions|sitelinks', languages: 'en', sitefilter: 'enwiki', format: 'json' });

  const ents = (await wdFetch(mapUrl)).entities || {};
  const out = [];
  for (const [qid, ent] of Object.entries(ents)) {
    if (!/^Q\d+$/.test(qid)) continue;           // "-1" means no item for that title
    out.push({
      qid,
      label: ent.labels?.en?.value || null,
      description: ent.descriptions?.en?.value || null,
      article: ent.sitelinks?.enwiki?.title || null
    });
  }
  return out;
}

/**
 * Full entity: type, occupations, date, location, death toll.
 *
 * P31 instance-of, P106 occupation, P585 point in time, P276 location,
 * P1120 number of deaths, P361 part-of. These are the properties the identity
 * checks and the baseline cross-check run on.
 */
async function fetchEntity(qid) {
  const url = 'https://www.wikidata.org/w/api.php?'
    + new URLSearchParams({ action: 'wbgetentities', ids: qid, props: 'claims|labels|sitelinks',
      sitefilter: 'enwiki', languages: 'en', format: 'json' });

  const ent = (await wdFetch(url)).entities?.[qid];
  if (!ent) return null;

  const claims = ent.claims || {};
  const ids = (prop) => (claims[prop] || [])
    .map(c => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
  const times = (prop) => (claims[prop] || [])
    .map(c => c.mainsnak?.datavalue?.value?.time).filter(Boolean);
  const amounts = (prop) => (claims[prop] || [])
    .map(c => c.mainsnak?.datavalue?.value?.amount).filter(Boolean)
    .map(a => String(a).replace(/^\+/, ''));

  return {
    qid,
    label: ent.labels?.en?.value || null,
    article: ent.sitelinks?.enwiki?.title || null,
    instanceOf: ids('P31'),
    occupations: ids('P106'),
    sports: ids('P641'),
    deathDate: times('P570'),
    pointInTime: times('P585'),
    location: ids('P276'),
    partOf: ids('P361'),
    deaths: amounts('P1120')
  };
}

/**
 * Human-readable labels for a set of QIDs.
 *
 * Wikidata caps wbgetentities at 50 ids, so this pages rather than truncating.
 * Truncating looked identical to "that QID has no label", which would have let
 * a channel decision be made on a label that was never actually fetched.
 */
async function labelsFor(qids) {
  const list = [...new Set(qids)].filter(Boolean);
  const out = {};
  for (let i = 0; i < list.length; i += 50) {
    const url = 'https://www.wikidata.org/w/api.php?'
      + new URLSearchParams({ action: 'wbgetentities', ids: list.slice(i, i + 50).join('|'), props: 'labels', languages: 'en', format: 'json' });
    try {
      const ents = (await wdFetch(url)).entities || {};
      for (const [k, v] of Object.entries(ents)) out[k] = v.labels?.en?.value || k;
    } catch { /* a missing label degrades the sheet; it never blocks it */ }
  }
  return out;
}

// Wikidata classes the per-type checks accept.
const HUMAN = 'Q5';
const PLACE_CLASSES = new Set([
  'Q483110', 'Q1076486', 'Q515', 'Q486972', 'Q56061', 'Q41176', 'Q17350442'
]);

/**
 * Does the pinned entity match what the topic claims to be about?
 *
 * The Furiani-class failure dies here: an `event` topic whose QID carries no
 * P585 point-in-time is not an event item, and one whose year disagrees with
 * the brief is a different event with a similar name.
 */
function checkIdentity(entity, { topicType, briefText, topicLabel }) {
  const problems = [];
  const warnings = [];
  if (!entity) return { ok: false, problems: ['entity could not be fetched'], warnings };

  if (topicType === 'person') {
    if (!entity.instanceOf.includes(HUMAN)) problems.push(`P31 is not human (${entity.instanceOf.join(', ') || 'none'})`);
    if (!entity.occupations.length) problems.push('no P106 occupation');
  }

  if (topicType === 'event') {
    // A MISSING date is not a MISMATCHED date.
    //
    // The rule is "P585 year == topic year else AUTO-REJECT", which is about an
    // item dated to the wrong year. Treating an undated item as a violation
    // rejected the correct entities outright: "Ellis Park Stadium disaster" and
    // "Bosman ruling" are exactly right and simply carry no P585. Undated is a
    // warning that costs confidence; wrongly dated is still a hard reject.
    if (!entity.pointInTime.length) {
      warnings.push('no P585 point in time — cannot confirm the year from Wikidata');
    } else {
      // Wikidata times look like +1971-01-02T00:00:00Z
      const qidYear = (/([+-]\d{4})/.exec(entity.pointInTime[0]) || [])[1]?.replace('+', '');
      const briefYears = [...new Set(String(briefText || '').match(/\b(1[89]\d\d|20\d\d)\b/g) || [])];
      if (qidYear && briefYears.length && !briefYears.includes(qidYear)) {
        problems.push(`P585 year ${qidYear} not present in brief (brief has ${briefYears.slice(0, 5).join(', ')})`);
      }
    }
  }

  if (topicType === 'place') {
    const isPlace = entity.instanceOf.some(i => PLACE_CLASSES.has(i));
    if (!isPlace) problems.push(`P31 is not a venue or settlement (${entity.instanceOf.join(', ') || 'none'})`);
    if (topicLabel && entity.label && !topicLabel.toLowerCase().includes(entity.label.toLowerCase().split(' ')[0])) {
      problems.push(`label "${entity.label}" does not match topic label`);
    }
  }

  return { ok: problems.length === 0, problems, warnings };
}

/**
 * Baseline claims straight from the pinned entity.
 *
 * These never pass on their own — Wikidata is one origin, and a toll it carries
 * is still a single source. Their job is the cross-check: any outside source
 * that DISAGREES with a baseline sends the claim to HUMAN immediately, which is
 * stronger than silence.
 */
function wikidataBaseline(entity) {
  const out = [];
  if (!entity) return out;
  for (const t of entity.pointInTime.slice(0, 1)) {
    const m = /([+-]\d{4})-(\d{2})-(\d{2})/.exec(t);
    if (m) out.push({ claim_type: 'date', claim_key: `${m[1].replace('+', '')}-${m[2]}-${m[3]}`, from: 'P585' });
  }
  for (const d of entity.deaths.slice(0, 1)) out.push({ claim_type: 'death_count', claim_key: d, from: 'P1120' });
  return out;
}

/** The Wikipedia article a QID actually points at — not a guess from the title. */
async function articleForQid(qid) {
  const url = 'https://www.wikidata.org/w/api.php?'
    + new URLSearchParams({ action: 'wbgetentities', ids: qid, props: 'sitelinks', sitefilter: 'enwiki', format: 'json' });

  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) return null;
  const data = await res.json();
  return data.entities?.[qid]?.sitelinks?.enwiki?.title || null;
}

/* ── index ─────────────────────────────────────────────────────────────── */

/** Every external reference the article cites. */
async function harvestReferences(articleTitle) {
  const out = [];
  let cont = null;

  do {
    const params = {
      action: 'query', titles: articleTitle, prop: 'extlinks',
      ellimit: '200', format: 'json', formatversion: '2'
    };
    if (cont) params.elcontinue = cont;

    const res = await fetch(`https://en.wikipedia.org/w/api.php?${new URLSearchParams(params)}`,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000) });
    if (!res.ok) break;
    const data = await res.json();

    for (const page of data.query?.pages || []) {
      for (const l of page.extlinks || []) out.push(typeof l === 'string' ? l : l.url);
    }
    cont = data.continue?.elcontinue || null;
  } while (cont && out.length < 400);

  // Wikipedia's own infrastructure is not a source for Wikipedia's claims.
  const SELF = /wikimedia|wikipedia|wikidata|creativecommons|mediawiki/i;
  return [...new Set(out)].filter(u => /^https?:/i.test(u) && !SELF.test(u));
}

/** Registrable domain — two outlets on the same host are one source. */
function domainOf(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    const parts = h.split('.');
    return parts.length > 2 ? parts.slice(-2).join('.') : h;
  } catch { return null; }
}

/**
 * A dead reference still counts if the Wayback Machine holds a capture.
 *
 * Returns a STATUS, not a boolean. A first run reported 0 of 12 captured, which
 * could equally have meant "these references are genuinely unarchived" or "we
 * were being throttled and never asked properly" — and those call for opposite
 * responses. Distinguishing them is the whole point of this shape.
 *
 * Paced to one request a second with exponential backoff on 429, because the
 * endpoint is shared infrastructure and hammering it produces exactly the
 * ambiguous zero that prompted this.
 */
let waybackNextAt = 0;

async function waybackStatus(url, attempt = 1) {
  const gap = Number(process.env.WAYBACK_GAP_MS) || 1000;
  const wait = Math.max(0, waybackNextAt - Date.now());
  waybackNextAt = Date.now() + wait + gap;
  if (wait) await new Promise(r => setTimeout(r, wait));

  const api = 'https://archive.org/wayback/available?url=' + encodeURIComponent(url);
  try {
    const res = await fetch(api, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });

    if (res.status === 429 || res.status === 503) {
      if (attempt >= 4) return { status: 'rate_limited', snapshot: null };
      await new Promise(r => setTimeout(r, 2000 * attempt * attempt));
      return waybackStatus(url, attempt + 1);
    }
    if (!res.ok) return { status: 'fetch_error', snapshot: null, detail: `HTTP ${res.status}` };

    const body = await res.text();
    if (!body.trim().startsWith('{')) return { status: 'rate_limited', snapshot: null };

    const snap = JSON.parse(body)?.archived_snapshots?.closest;
    return snap?.available
      ? { status: 'captured', snapshot: snap.url }
      : { status: 'no_capture', snapshot: null };
  } catch (error) {
    return { status: 'fetch_error', snapshot: null, detail: String(error.message).slice(0, 60) };
  }
}

/** Back-compat wrapper: the URL of a capture, or null. */
async function waybackFor(url) {
  return (await waybackStatus(url)).snapshot;
}

/* ── matcher widening (lookup-table math, never judgement) ─────────────── */

const ONES = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/**
 * "sixty-six" -> 66, for one to one hundred. A table, not an inference.
 *
 * This exists because "sixty-six fatalities" and "66 died" are the same fact,
 * and refusing to match them fails true claims for no reason. It stops at a
 * hundred deliberately: beyond that, written-out numbers in sources are almost
 * always approximations, and approximations are handled below.
 */
function word2num(phrase) {
  const t = String(phrase).toLowerCase().trim().replace(/\s+and\s+/g, ' ');
  if (t === 'hundred' || t === 'one hundred') return 100;
  const parts = t.split(/[\s-]+/).filter(Boolean);
  if (!parts.length || parts.length > 2) return null;
  if (parts.length === 1) {
    if (ONES[parts[0]] !== undefined) return ONES[parts[0]];
    if (TENS[parts[0]] !== undefined) return TENS[parts[0]];
    return null;
  }
  const [a, b] = parts;
  return TENS[a] !== undefined && ONES[b] !== undefined && ONES[b] < 10 ? TENS[a] + ONES[b] : null;
}

/**
 * Does this text assert the same numeric value as the claim?
 *
 *   "at least 66"         -> 66   uncertainty points downward only, so the
 *                                 floor being the claimed figure IS the claim
 *   "around 66" / "~66"   -> NOT a match; a rounded figure is not the fact
 *   "sixty-six"           -> 66   via the table above
 */
function valueMatches(value, text) {
  const target = Number(String(value).replace(/,/g, ''));
  if (!Number.isFinite(target)) return false;
  const hay = String(text || '').toLowerCase().replace(/,/g, '');

  const APPROX = /(around|about|approximately|roughly|some|nearly|almost|up to|more than|over|~)\s*$/;

  for (const m of hay.matchAll(/\b(\d{1,7})\b/g)) {
    if (Number(m[1]) !== target) continue;
    if (APPROX.test(hay.slice(Math.max(0, m.index - 18), m.index))) continue;
    return true;
  }

  for (const m of hay.matchAll(/\b([a-z]+(?:[\s-][a-z]+)?)\b/g)) {
    if (word2num(m[1]) !== target) continue;
    if (APPROX.test(hay.slice(Math.max(0, m.index - 18), m.index))) continue;
    return true;
  }

  return false;
}

/* ── claims ────────────────────────────────────────────────────────────── */

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';

const MONTH_NUM = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
};

/**
 * Every date to ISO-8601 before two of them are ever compared.
 *
 * The cross-check was reporting "brief says 2 January 1971, P585 says
 * 1971-01-02 — disagreement, forcing HUMAN". That is the same day written two
 * ways, and a human reviewer sent to read it learns nothing. Deterministic
 * table lookup, same class as word2num: no parsing of anything ambiguous, and
 * null rather than a guess when the shape is unrecognised.
 */
function normalizeDate(value) {
  const s = String(value || '').trim();

  let m = /^([+-]?\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return iso(m[1], m[2], m[3]);

  m = new RegExp(`^(\\d{1,2})\\s+(${MONTHS})\\s+(\\d{4})$`, 'i').exec(s);
  if (m) return iso(m[3], MONTH_NUM[m[2].toLowerCase()], m[1]);

  m = new RegExp(`^(${MONTHS})\\s+(\\d{1,2}),?\\s+(\\d{4})$`, 'i').exec(s);
  if (m) return iso(m[3], MONTH_NUM[m[1].toLowerCase()], m[2]);

  return null;
}

function iso(y, mo, d) {
  const year = String(y).replace('+', '').padStart(4, '0');
  return `${year}-${String(Number(mo)).padStart(2, '0')}-${String(Number(d)).padStart(2, '0')}`;
}

/**
 * Do a brief claim and a Wikidata baseline assert the same thing?
 *
 * Deliberately conservative in one direction: when a value cannot be parsed
 * into a canonical form, this falls back to raw string comparison, which can
 * only ever produce MORE human review, never less. Silent agreement is the
 * failure mode that matters here.
 */
function sameClaimValue(type, a, b) {
  if (type === 'date') {
    const na = normalizeDate(a);
    const nb = normalizeDate(b);
    if (na && nb) return na === nb;
  }
  if (type === 'death_count') {
    const na = Number(String(a).replace(/[,\s]/g, ''));
    const nb = Number(String(b).replace(/[,\s]/g, ''));
    if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  }
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/**
 * The sentence-level gate on death tolls. A number only becomes a death count
 * if the sentence it sits in is about deaths.
 */
const DEATH_LEXICON = /\b(?:died|dies|killed|fatalit(?:y|ies)|dead|deaths?|perished|lost their lives|loss of life)\b/i;

/** The sentences of a passage, for gating and for provenance. */
function sentencesOf(text) {
  const s = String(text || '');
  return s.match(/[^.!?]+[.!?]+/g) || (s.trim() ? [s] : []);
}

/**
 * Five claim types, pulled by pattern from the brief's own sentences.
 *
 * `claim_key` is what gets matched against sources, so it must be a bare value
 * — a number, a date, a name. Matching on a whole sentence would never hit.
 */
function extractClaims(briefText, { drops = [] } = {}) {
  const sentences = sentencesOf(briefText);
  const claims = [];
  const push = (type, key, text) => {
    const k = String(key).trim();
    if (!k) return;
    if (claims.some(c => c.claim_type === type && c.claim_key === k)) return;
    claims.push({ claim_type: type, claim_key: k, claim_text: text.trim().slice(0, 400) });
  };

  for (const s of sentences) {
    // date — "2 January 1971" or "January 2, 1971"
    const d1 = new RegExp(`\\b(\\d{1,2}\\s+(?:${MONTHS})\\s+\\d{4})\\b`).exec(s);
    const d2 = new RegExp(`\\b((?:${MONTHS})\\s+\\d{1,2},?\\s+\\d{4})\\b`).exec(s);
    if (d1) push('date', d1[1], s);
    else if (d2) push('date', d2[1], s);

    // death count — the number itself, not the phrasing around it
    //
    // GATED: only a sentence that is ABOUT deaths may yield a toll. Ungated,
    // the Ibrox brief produced 25 - a figure lifted from an injuries sentence
    // while Wikidata's P1120 said 66. The cross-check caught that one only
    // because a baseline happened to exist; the gate stops it being extracted
    // at all. An injuries sentence can never feed a death_count claim.
    const dc = /\b(\d[\d,]{0,7})\s+(?:people\s+)?(?:were\s+)?(?:died|killed|dead|fatalities|deaths|perished|lost their lives)\b/i.exec(s)
      || /\b(?:killed|claimed the lives of|death toll of|perished)\s+(\d[\d,]{0,7})\b/i.exec(s);
    if (dc) {
      if (DEATH_LEXICON.test(s)) push('death_count', dc[1].replace(/,/g, ''), s);
      // A drop is recorded, not silent. The digest reports what the gate
      // refused, because a gate nobody can audit is a gate nobody can trust —
      // and if it starts eating true claims, this is where that shows up.
      else drops.push({ claim_type: 'death_count', value: dc[1].replace(/,/g, ''), sentence: s.trim().slice(0, 300), reason: 'no death lexicon in sentence' });
    }

    // place — proper noun after at/in, two words max
    const pl = /\b(?:at|in)\s+([A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)?)\b/.exec(s);
    if (pl && !new RegExp(`^(?:${MONTHS})$`).test(pl[1])) push('place', pl[1], s);

    // person + role — "X was a Y" / "X, a Y,"
    const pr = /\b([A-Z][a-z'-]+(?:\s+[A-Z][\w'-]+){1,2})(?:,|\s+was)\s+(?:a|an|the)\s+([a-z][a-z\s-]{3,30})\b/.exec(s);
    if (pr) push('person_role', `${pr[1]}|${pr[2].trim()}`, s);

    // cause — the clause, kept short
    const ca = /\b(?:caused by|due to|as a result of|ruled to be|attributed to|blamed on)\s+([^.,;]{4,70})/i.exec(s);
    if (ca) push('cause', ca[1].trim(), s);
  }

  return claims;
}

/* ── verify ────────────────────────────────────────────────────────────── */

/**
 * The value a source must contain for a claim to count as corroborated.
 *
 * For person_role only the NAME is required, not the role wording — a
 * "midfielder" and a "footballer" are the same fact stated two ways, and
 * demanding both would fail every true claim. Everything else must appear
 * literally.
 */
function matchTokens(claim) {
  if (claim.claim_type === 'person_role') return [claim.claim_key.split('|')[0]];
  if (claim.claim_type === 'cause') return claim.claim_key.split(/\s+/).filter(w => w.length > 4).slice(0, 3);
  return [claim.claim_key];
}

const norm = (s) => String(s || '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/,/g, '').toLowerCase();

/**
 * The exact sentence in a source that corroborates a claim, or null.
 *
 * Matching is done per SENTENCE rather than across the whole snippet, for two
 * reasons that are really one reason.
 *
 * First, the death gate has to apply here too. Matching a toll anywhere in a
 * passage meant a Google Books snippet reading "145 were injured, including 25
 * children" corroborated a death_count of 25 — the same bug as the extractor,
 * but worse, because two such snippets are a PASS. A toll now only counts when
 * the sentence carrying the number is itself about deaths.
 *
 * Second, it hands back provenance for free. The sentence that matched is what
 * gets stored, so HUMAN review is reading one line rather than a whole snippet.
 */
function matchingSentence(claim, text) {
  const tokens = matchTokens(claim).map(norm).filter(Boolean);

  for (const raw of sentencesOf(text)) {
    const hay = norm(raw);

    if (claim.claim_type === 'death_count') {
      // The lookup-table matcher, but only inside a sentence about deaths.
      if (!DEATH_LEXICON.test(raw)) continue;
      if (valueMatches(claim.claim_key, raw)) return raw.trim();
      continue;
    }

    if (!tokens.length) continue;
    // A cause needs all its keywords present; everything else is one value.
    const hit = claim.claim_type === 'cause'
      ? tokens.every(t => hay.includes(t))
      : tokens.some(t => hay.includes(t));
    if (hit) return raw.trim();
  }

  return null;
}

/** Back-compat wrapper: does any sentence in this source corroborate the claim? */
function sourceMatches(claim, text) {
  return Boolean(matchingSentence(claim, text));
}

async function searchGoogleBooks(query) {
  const url = 'https://www.googleapis.com/books/v1/volumes?maxResults=5&q=' + encodeURIComponent(query);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.items || []).map(v => ({
      provider: 'google_books',
      url: v.volumeInfo?.infoLink || `https://books.google.com/books?id=${v.id}`,
      title: v.volumeInfo?.title || null,
      snippet: [v.searchInfo?.textSnippet, v.volumeInfo?.description].filter(Boolean).join(' ').slice(0, 600)
    }));
  } catch { return []; }
}

async function searchGdelt(query) {
  const url = 'https://api.gdeltproject.org/api/v2/doc/doc?format=json&maxrecords=10&query='
    + encodeURIComponent(query);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000) });
    if (!res.ok) return [];
    const text = await res.text();
    if (!text.trim().startsWith('{')) return [];   // GDELT serves HTML when throttled
    const data = JSON.parse(text);
    return (data.articles || []).map(a => ({
      provider: 'gdelt', url: a.url, title: a.title || null, snippet: a.title || ''
    }));
  } catch { return []; }
}

async function searchGoogleNews(query) {
  const url = 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=' + encodeURIComponent(query);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    return items.slice(0, 10).map(it => {
      const title = (/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(it) || [])[1] || null;
      return {
        provider: 'google_news',
        url: (/<link>([\s\S]*?)<\/link>/.exec(it) || [])[1] || '',
        title,
        snippet: title || ''
      };
    }).filter(r => r.url);
  } catch { return []; }
}

/**
 * What each verifier can actually see.
 *
 * GDELT's index starts in 2015 and Google News RSS is a trailing window of
 * roughly a month. Neither can hold a contemporaneous report of a 1971 crush,
 * so when either "corroborated" an Ibrox claim it was matching a token in a
 * modern headline — "Motherwell deal Rangers title setback at Ibrox" counting
 * as evidence for a 1971 disaster. A verifier that cannot see the year cannot
 * vote on it.
 *
 * `from`/`to` are inclusive years; null means unbounded. Google Books is the
 * only all-era source here, which is exactly why pre-2000 runs HUMAN.
 */
const COVERAGE = {
  google_books: { from: null, to: null },
  gdelt: { from: 2015, to: null },
  google_news: { from: null, to: null, trailingDays: 30 }
};

/** A bare year, carrying no day. Never enough to corroborate a dated claim. */
function isYearOnly(value) {
  return /^\s*(1[89]\d\d|20\d\d)\s*$/.test(String(value || ''));
}

/** Can this provider have seen the event year at all? */
function coversYear(provider, year) {
  const c = COVERAGE[provider];
  if (!c || !year) return true;                 // unknown provider or undated claim: no era opinion
  const y = Number(year);
  if (!Number.isFinite(y)) return true;
  if (c.from && y < c.from) return false;
  if (c.to && y > c.to) return false;
  if (c.trailingDays) {
    const cutoff = new Date(Date.now() - c.trailingDays * 86400000).getUTCFullYear();
    if (y < cutoff) return false;
  }
  return true;
}

/**
 * Does this sentence place the claim in its event, rather than merely repeat a
 * word from it?
 *
 * A place claim was being corroborated by any headline containing "Ibrox" —
 * the same disease as the injury snippets, one field over. A place only counts
 * when its sentence also carries something event-specific: the death lexicon,
 * the event year, or a distinguishing word from the event's own label.
 */
function hasEventContext(sentence, { eventYear, eventLabel, placeToken }) {
  const s = String(sentence || '');
  if (DEATH_LEXICON.test(s)) return true;
  if (eventYear && new RegExp(`\\b${eventYear}\\b`).test(s)) return true;

  const place = norm(placeToken);
  const distinguishing = norm(eventLabel).split(/\s+/)
    .filter((w) => w.length > 3 && !place.includes(w) && !/^\d+$/.test(w));
  const hay = norm(s);
  return distinguishing.some((w) => hay.includes(w));
}

/**
 * Verify one claim. Passes only on two INDEPENDENT agreeing sources.
 *
 * Independence is by registrable domain: two outlets running the same wire copy
 * are one source, and counting them twice is exactly how a single unchecked
 * report becomes "corroborated".
 */
async function verifyClaim(claim, subject, { eventYear = null, eventLabel = '' } = {}) {
  const query = `${subject} ${claim.claim_key.split('|')[0]}`.slice(0, 200);

  // One request a second on external endpoints. GDELT answers a burst with
  // HTML instead of JSON, which parses as "no results" — a throttle wearing the
  // costume of a finding, the same failure as Wikidata's 429s.
  const beat = () => new Promise((r) => setTimeout(r, 1000));
  const results = [];
  for (const search of [searchGoogleBooks, searchGdelt, searchGoogleNews]) {
    results.push(...await search(query));
    await beat();
  }

  const sources = results.map(r => {
    const sentence = matchingSentence(claim, `${r.title} ${r.snippet}`);
    let reject_reason = null;

    // E — a verifier that cannot see the event year cannot vote on it.
    if (sentence && !coversYear(r.provider, eventYear)) reject_reason = 'ANACHRONISTIC';

    // H — a year is not a date. "1971" inside "1971-01-02" proves the year and
    // says nothing about the day, so it can corroborate nothing on its own.
    if (sentence && !reject_reason && claim.claim_type === 'date' && isYearOnly(claim.claim_key)) {
      reject_reason = 'YEAR_ONLY';
    }

    // F — a place needs its event, not just its name.
    if (sentence && !reject_reason && claim.claim_type === 'place'
      && !hasEventContext(sentence, { eventYear, eventLabel, placeToken: claim.claim_key })) {
      reject_reason = 'NO_EVENT_CONTEXT';
    }

    return {
      ...r,
      domain: domainOf(r.url),
      matched: Boolean(sentence) && !reject_reason,
      source_sentence: sentence,
      reject_reason
    };
  });
  const agreeing = sources.filter(s => s.matched && s.domain);
  const independent = new Set(agreeing.map(s => s.domain));

  return {
    sources,
    independentCount: independent.size,
    verdict: independent.size >= 2 ? 'verified' : 'human'
  };
}

module.exports = {
  pinIdentity, searchWikipediaQids, articleForQid, fetchEntity, labelsFor, checkIdentity, wikidataBaseline,
  harvestReferences, waybackFor, waybackStatus, domainOf,
  extractClaims, verifyClaim, sourceMatches, matchingSentence, sentencesOf,
  word2num, valueMatches, RateLimited, DEATH_LEXICON,
  COVERAGE, coversYear, hasEventContext, isYearOnly, PLACE_CLASSES,
  normalizeDate, sameClaimValue, logger
};
