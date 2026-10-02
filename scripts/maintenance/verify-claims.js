#!/usr/bin/env node
/**
 * SOURCE LAYER v1 — run claim verification over a topic and record the verdicts.
 *
 *   node scripts/verify-claims.js --topic ibrox
 *   node scripts/verify-claims.js --limit 5
 *   node scripts/verify-claims.js --topic ibrox --dry-run
 *
 * Pipeline, in order:
 *   1 IDENTITY  Wikidata QID for the topic, and the article that QID points at.
 *               If the brief came from a DIFFERENT article, that is the
 *               wrong-subject bug and the topic is blocked outright — no amount
 *               of source agreement rescues a brief about the wrong thing.
 *   2 INDEX     The article's own external references; dead ones via Wayback.
 *   3 CLAIMS    Five claim types, by pattern, from the brief.
 *   4 VERIFY    Google Books + GDELT + Google News, keyless.
 *   5 RULE      Two INDEPENDENT agreeing domains, or HUMAN.
 *   6 LEDGER    Claim -> source -> verdict, into Postgres, approved:false.
 *
 * Nothing here can approve a topic. It can only block one, or narrow what a
 * human has to read.
 */

require('dotenv').config();

const fsp = require('fs').promises;
const path = require('path');
const {
  fetchEntity, checkIdentity, wikidataBaseline, harvestReferences, waybackStatus,
  extractClaims, verifyClaim, sameClaimValue, normalizeDate
} = require('../../utils/source-layer');
const { isBuildable } = require('../../utils/lanes');
const { Logger } = require('../../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const DATA_ROOT = process.env.DATA_ROOT || 'data';
const QUEUE_PATH = path.join(ROOT, DATA_ROOT, 'queue.json');
const BRIEF_DIR = path.join(ROOT, 'data', 'research', 'briefs');
const logger = new Logger('VerifyClaims');

/** The year a topic is about, when the pinned entity carries no date of its own. */
function topicYearOf(entry) {
  const YEAR = /\b(1[89]\d\d|20\d\d)\b/;
  for (const field of [entry.topic, (entry.keywords || []).join(' '), entry.angle || '']) {
    const m = YEAR.exec(String(field));
    if (m) return m[1];
  }
  return null;
}

function db() {
  const url = process.env.WHOP_OS_DATABASE_URL;
  if (!url) throw new Error('WHOP_OS_DATABASE_URL is not set — nowhere to write the ledger.');
  return require('postgres')(url, { ssl: 'require', max: 1, connect_timeout: 15 });
}

/**
 * Deterministic smells in the extraction itself, for the morning digest.
 *
 * None of these is a verdict. They are the things that, every time one has
 * turned up, were a bug rather than a fact: a brief too thin to write from, a
 * claim whose value is not in the sentence it came from, two different death
 * tolls in one topic (which means two events in one article), a date that
 * cannot be normalised.
 */
function extractionAnomalies(claims, briefText) {
  const out = [];
  const text = String(briefText || '');
  if (text.length < 1200) out.push(`thin brief - ${text.length} chars, under the 1200 floor`);
  if (!claims.length && text.length) out.push('no claims extracted from a non-empty brief');

  for (const c of claims) {
    const key = c.claim_type === 'person_role' ? c.claim_key.split('|')[0] : c.claim_key;
    if (key && !String(c.claim_text).toLowerCase().includes(String(key).toLowerCase())) {
      out.push(`${c.claim_type} "${key}" does not appear in its own source sentence`);
    }
    if (c.claim_type === 'date' && !normalizeDate(c.claim_key)) {
      out.push(`date "${c.claim_key}" could not be normalised to ISO-8601`);
    }
  }

  const tolls = [...new Set(claims.filter(c => c.claim_type === 'death_count').map(c => c.claim_key))];
  if (tolls.length > 1) {
    out.push(`${tolls.length} different death tolls in one topic (${tolls.join(', ')}) - more than one event in the brief?`);
  }
  return out;
}

/**
 * Why a claim needs a human, in five words the ledger can count.
 *
 * These are LABELS, not decisions — nothing here approves or rejects anything.
 * Their job is to make the ledger answer "what is actually broken?" When one
 * category dominates, it names the module to fix next. Assignment is
 * deterministic: every branch below is a fact already established upstream, so
 * there is no judgement, no model, and no widening hiding in here.
 */
function resolutionCategory(verdict, claim, sources) {
  if (verdict === 'verified') return null;

  // Wikidata already said this value belongs to a different occurrence — the
  // 1902 toll inside a 1971 topic.
  if (claim.disagrees) return 'different_event';

  const reasons = new Set(sources.map((s) => s.reject_reason).filter(Boolean));
  // Something matched, but only from an index that cannot see the era, or from
  // a sentence that never placed the claim in its event.
  if (reasons.has('ANACHRONISTIC')) return 'coverage_gap';
  if (reasons.has('NO_EVENT_CONTEXT')) return 'ambiguous_source';
  if (reasons.has('YEAR_ONLY')) return 'ambiguous_source';

  // The claim's own value is absent from the sentence it was extracted from,
  // which is an extractor fault rather than a sourcing one.
  const key = claim.claim_type === 'person_role' ? claim.claim_key.split('|')[0] : claim.claim_key;
  if (key && !String(claim.claim_text || '').toLowerCase().includes(String(key).toLowerCase())) {
    return 'wrong_extraction';
  }

  // Nothing matched anywhere: the sources simply do not reach this claim.
  return sources.some((s) => s.source_sentence) ? 'ambiguous_source' : 'coverage_gap';
}

async function verifyTopic(sql, entry, { dryRun, refLimit = 12 }) {
  const subject = entry.keywords?.[0] || entry.topic;
  logger.info(`-- ${entry.id}: ${entry.topic}`);

  // 1 — IDENTITY, from the pin. Never searched at run time.
  //
  // Searching here is what produced the stadium instead of the disaster. The
  // QID is pinned by a human in the queue; if it is absent there is no anchor,
  // and without an anchor there is nothing to verify against.
  if (!entry.entity_qid) {
    logger.warn('   UNPINNED — no entity_qid in the queue. Run pin-identities.js. BLOCKED');
    return { id: entry.id, blocked: 'no entity_qid pinned' };
  }
  if (!entry.topic_type) {
    logger.warn('   no topic_type — cannot choose identity checks. BLOCKED');
    return { id: entry.id, qid: entry.entity_qid, blocked: 'no topic_type' };
  }

  const entity = await fetchEntity(entry.entity_qid);
  if (!entity) {
    logger.warn(`   ${entry.entity_qid} could not be fetched. BLOCKED`);
    return { id: entry.id, qid: entry.entity_qid, blocked: 'entity unreachable' };
  }
  const identity = { qid: entity.qid, label: entity.label, description: null };
  const article = entity.article;
  logger.info(`   ${entity.qid} ${entity.label} [${entry.topic_type}]`);

  const brief = await fsp.readFile(path.join(BRIEF_DIR, `${entry.id}.json`), 'utf8')
    .then(JSON.parse).catch(() => null);
  if (!brief) {
    logger.warn('   no cached brief — nothing to verify, BLOCKED');
    return { id: entry.id, qid: identity.qid, blocked: 'no brief' };
  }

  // 1b — per-type identity checks. An `event` with no P585 is not an event
  // item, which is the Furiani-class failure.
  const idCheck = checkIdentity(entity, {
    topicType: entry.topic_type, briefText: brief.text, topicLabel: entry.topic
  });
  for (const p of idCheck.problems) logger.warn(`   IDENTITY: ${p}`);

  // The check that would have caught MH370 citing a conspiracy book: the brief
  // must come from the article the pinned identity actually points at.
  const mismatch = Boolean(article && brief.title && article.toLowerCase() !== brief.title.toLowerCase());
  if (mismatch) {
    logger.warn(`   BRIEF MISMATCH — identity says "${article}", brief is "${brief.title}"`);
  }

  // 2 — INDEX. Capture status is reported per outcome, because "0 captured"
  // meant nothing when it could equally have been throttling.
  const refs = article ? await harvestReferences(article) : [];
  const tally = { captured: 0, no_capture: 0, fetch_error: 0, rate_limited: 0 };
  for (const url of refs.slice(0, refLimit)) {
    tally[(await waybackStatus(url)).status]++;
  }
  logger.info(`   ${refs.length} reference(s); of ${Math.min(refLimit, refs.length)} sampled — `
    + `${tally.captured} captured, ${tally.no_capture} no capture, `
    + `${tally.fetch_error} error, ${tally.rate_limited} rate-limited`);

  // 3 — CLAIMS, plus the entity's own baseline as cross-check candidates.
  const lexiconDrops = [];
  const claims = extractClaims(brief.text, { drops: lexiconDrops });
  for (const d of lexiconDrops) {
    logger.warn(`   GATE DROPPED ${d.claim_type} ${d.value} — ${d.reason}`);
  }
  const baseline = wikidataBaseline(entity);
  const crossChecks = [];
  for (const b of baseline) {
    const same = (c) => sameClaimValue(b.claim_type, c.claim_key, b.claim_key);
    const mine = claims.filter(c => c.claim_type === b.claim_type);

    // Dates and tolls fail differently, so they are flagged differently.
    //
    // A brief cites many dates legitimately — the Ibrox inquiry opened six
    // weeks after the crush — so a date contradicts the entity only when the
    // brief states the pinned date NOWHERE.
    //
    // A toll is not like that. P1120 is the toll for THIS entity, and the Ibrox
    // article carries 1902's 25 and 1971's 66 side by side. Either number can
    // be copied into narration and read as correct, and 25 IS a true sentence
    // about a different disaster — so corroboration will happily confirm it.
    // Every toll that is not the pinned entity's own therefore goes to a human.
    const flagged = b.claim_type === 'death_count'
      ? mine.filter(c => !same(c))
      : (mine.some(same) ? [] : mine.slice(0, 1));

    for (const clash of flagged) {
      logger.warn(`   CROSS-CHECK: brief says ${b.claim_type} ${clash.claim_key}, `
        + `${b.from} says ${b.claim_key} — disagreement, forcing HUMAN`);
      clash.disagrees = true;
      crossChecks.push({ claim_type: b.claim_type, brief: clash.claim_key, entity: b.claim_key, from: b.from });
    }
  }
  const anomalies = extractionAnomalies(claims, brief.text);
  for (const a of anomalies) logger.warn(`   ANOMALY: ${a}`);
  logger.info(`   ${claims.length} claim(s) extracted, ${baseline.length} Wikidata baseline`);

  // 4 + 5 — VERIFY
  // The event year and label are what the era gate and the place-context gate
  // measure a source against, so they come from the pinned entity, not prose.
  const eventYear = (/([+-]\d{4})/.exec(entity.pointInTime[0] || entity.deathDate[0] || '') || [])[1]
    ?.replace('+', '') || topicYearOf(entry);
  const eventLabel = entity.label || entry.topic;

  const verdicts = [];
  for (const claim of claims) {
    const result = await verifyClaim(claim, subject, { eventYear, eventLabel });
    // Wikidata never passes a toll alone, but it can veto one: a claim that
    // contradicts the pinned entity goes to HUMAN regardless of agreement.
    if (claim.disagrees) result.verdict = 'human';
    const category = resolutionCategory(result.verdict, claim, result.sources);
    verdicts.push({ claim, category, ...result });

    const rejected = result.sources.filter((s) => s.reject_reason);
    const note = rejected.length
      ? `  (${[...new Set(rejected.map((s) => s.reject_reason))].join(',')} x${rejected.length})`
      : '';
    logger.info(`   ${result.verdict === 'verified' ? 'PASS ' : 'HUMAN'} `
      + `${claim.claim_type.padEnd(12)} ${claim.claim_key.slice(0, 30).padEnd(32)} `
      + `${result.independentCount} src ${(category || '').padEnd(17)}${note}`);
  }

  const human = verdicts.filter(v => v.verdict === 'human').length;
  const blocked = !idCheck.ok ? `identity: ${idCheck.problems[0]}`
    : mismatch ? 'brief is not the pinned subject'
      : (human ? `${human} claim(s) unverified` : null);

  const report = {
    id: entry.id, qid: identity.qid, claims: verdicts.length, human, blocked,
    crossChecks, anomalies, lexiconDrops,
    categories: verdicts.filter(v => v.category).reduce((acc, v) => {
      acc[v.category] = (acc[v.category] || 0) + 1;
      return acc;
    }, {}),
    identity: idCheck.problems.concat(mismatch ? [`brief is "${brief.title}", identity says "${article}"`] : []),
    wayback: tally, refs: refs.length
  };
  if (dryRun) return report;

  // 6 — LEDGER
  await sql`
    insert into topic_identity (topic_id, qid, label, description, article_title)
    values (${entry.id}, ${identity.qid}, ${identity.label}, ${identity.description}, ${article})
    on conflict (topic_id) do update set qid = excluded.qid, label = excluded.label,
      description = excluded.description, article_title = excluded.article_title
  `;

  for (const v of verdicts) {
    const [row] = await sql`
      insert into claims (topic_id, claim_type, claim_key, claim_text, verdict, source_count, human_category, decided_at)
      values (${entry.id}, ${v.claim.claim_type}, ${v.claim.claim_key}, ${v.claim.claim_text},
              ${v.verdict}, ${v.independentCount}, ${v.category}, now())
      on conflict (topic_id, claim_type, claim_key) do update
        set verdict = excluded.verdict, source_count = excluded.source_count,
            human_category = excluded.human_category, decided_at = now()
      returning id
    `;
    await sql`delete from claim_sources where claim_id = ${row.id}`;
    for (const s of v.sources.filter(x => x.url).slice(0, 12)) {
      // source_sentence is the exact line that corroborated the claim, so a
      // reviewer reads one sentence instead of a 600-character snippet.
      await sql`
        insert into claim_sources (claim_id, provider, url, domain, title, snippet, matched, source_sentence, reject_reason)
        values (${row.id}, ${s.provider}, ${s.url}, ${s.domain}, ${s.title},
                ${String(s.snippet || '').slice(0, 500)}, ${s.matched},
                ${s.source_sentence ? String(s.source_sentence).slice(0, 500) : null},
                ${s.reject_reason || null})
      `;
    }
  }

  await sql`
    insert into topic_approval (topic_id, approved, blocked_reason, updated_at)
    values (${entry.id}, false, ${blocked}, now())
    on conflict (topic_id) do update
      set approved = false, blocked_reason = excluded.blocked_reason, updated_at = now()
  `;

  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const get = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
  const dryRun = args.includes('--dry-run');
  const only = get('--topic');
  const limit = Number(get('--limit', '0')) || 0;

  const queue = JSON.parse(await fsp.readFile(QUEUE_PATH, 'utf8'));
  // `short` rows are upload bookkeeping; `cut` and `parked` rows are decisions.
  // Neither is verified: that would spend the throttle budget re-proving
  // something nobody intends to build.
  let topics = queue.topics.filter(isBuildable);
  if (only) topics = topics.filter(t => t.id === only);
  if (!topics.length) throw new Error(only ? `no topic "${only}" in the queue` : 'no topics');
  if (limit) topics = topics.slice(0, limit);

  // Only open a connection when something will actually be written.
  const sql = dryRun ? null : db();
  const out = [];
  try {
    for (const entry of topics) out.push(await verifyTopic(sql, entry, { dryRun }));
  } finally {
    if (sql) await sql.end({ timeout: 5 }).catch(() => {});
  }

  const blocked = out.filter(o => o.blocked);
  logger.info('');
  logger.info(`${out.length} topic(s): ${out.length - blocked.length} clear, ${blocked.length} blocked`);
  for (const b of blocked) logger.warn(`   ${b.id}: ${b.blocked}`);
  if (!dryRun) logger.info('All topics remain approved:false until a human signs off.');
}

if (require.main === module) {
  main().catch(error => {
    logger.error(`verify-claims failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { verifyTopic, extractionAnomalies };
