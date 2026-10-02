#!/usr/bin/env node
/**
 * NIGHTLY VERIFY — run the source layer over the whole queue, write the ledger,
 * leave a digest to read in the morning.
 *
 *   node scripts/nightly-verify.js
 *   node scripts/nightly-verify.js --limit 5 --dry-run
 *   node scripts/nightly-verify.js --topic ibrox
 *   node scripts/nightly-verify.js --fresh      # ignore tonight's checkpoint
 *
 * WHAT THIS JOB CANNOT DO, BY CONSTRUCTION — not by promise:
 *
 *  - It cannot render. Nothing in this file's import graph reaches
 *    produce-longform, build-compilation, make-doc-short or ffmpeg. There is no
 *    code path from here to a render.
 *  - It cannot publish. Nothing here imports the YouTube client, upload-shorts
 *    or publish-video.
 *  - It cannot approve. The only statement that writes topic_approval lives in
 *    verifyTopic() and passes the literal `false`. On top of that, this job
 *    reads the set of approved topics BEFORE the run and again AFTER, and exits
 *    non-zero if that set grew. A human moves a topic to approved. Not this.
 *
 * Sequential on purpose. Wikidata, Wikipedia and Wayback all throttle, and a
 * parallel run returns throttles that read exactly like findings — the bug that
 * made a rate-limited identity pass recommend cutting 30 real topics.
 */

require('dotenv').config();

const fsp = require('fs').promises;
const path = require('path');
const { verifyTopic } = require('./verify-claims');
const { isBuildable } = require('../../utils/lanes');
const { check: anniversariesDue } = require('./anniversaries');
const { Logger } = require('../../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const DATA_ROOT = process.env.DATA_ROOT || 'data';
const QUEUE_PATH = path.join(ROOT, DATA_ROOT, 'queue.json');
const DIGEST_DIR = path.join(ROOT, DATA_ROOT, 'verify');
const PROGRESS_PATH = path.join(ROOT, DATA_ROOT, 'nightly-progress.json');
const logger = new Logger('NightlyVerify');

/**
 * Per-topic checkpoint, house style.
 *
 * A full pass is a minute or more per topic once external endpoints start
 * asking for backoffs, and this machine has killed long runs for memory at
 * topic 28. Writing after every topic means a kill costs one topic, and a
 * re-run only does the work that is actually missing.
 */
const loadProgress = () => fsp.readFile(PROGRESS_PATH, 'utf8').then(JSON.parse).catch(() => ({ reports: {} }));
const saveProgress = (p) => fsp.writeFile(PROGRESS_PATH, JSON.stringify(p, null, 2));

function db() {
  const url = process.env.WHOP_OS_DATABASE_URL;
  if (!url) throw new Error('WHOP_OS_DATABASE_URL is not set — nowhere to write the ledger.');
  return require('postgres')(url, { ssl: 'require', max: 1, connect_timeout: 15 });
}

/** Topic ids currently signed off by a human. The guard compares two of these. */
async function approvedSet(sql) {
  const rows = await sql`select topic_id from topic_approval where approved = true`;
  return new Set(rows.map((r) => r.topic_id));
}

function digestFor(reports, guard, startedAt, corrections = [], due = []) {
  const done = reports.filter((r) => !r.error);
  const blocked = done.filter((r) => r.blocked);
  const claims = done.reduce((n, r) => n + (r.claims || 0), 0);
  const human = done.reduce((n, r) => n + (r.human || 0), 0);
  const crossChecks = done.flatMap((r) => (r.crossChecks || []).map((c) => ({ ...c, id: r.id })));
  const anomalies = done.flatMap((r) => (r.anomalies || []).map((a) => ({ id: r.id, text: a })));
  const failed = reports.filter((r) => r.error);
  const minutes = Math.round((Date.now() - startedAt) / 60000);

  const L = [`# Verification digest — ${new Date().toISOString().slice(0, 10)}`, '',
    `${reports.length} topic(s) in ${minutes} min · ${done.length - blocked.length} clear · ${blocked.length} blocked · ${failed.length} errored`,
    `${claims} claim(s) decided — **${claims - human} PASS · ${human} HUMAN**`, ''];

  L.push('## Approval guard', '');
  L.push(guard.ok
    ? `${guard.before} approved before, ${guard.after} after — unchanged, as required.`
    : `**FAILED** — approved count went ${guard.before} to ${guard.after}. This job must never approve anything.`);
  L.push('');

  if (blocked.length) {
    L.push('## Blocked', '');
    for (const r of blocked) L.push(`- **${r.id}** — ${r.blocked}`);
    L.push('');
  }

  // G — why the HUMAN pile is the size it is. Labels, not decisions: the point
  // is that a dominant category names the module to fix next.
  const cats = done.reduce((acc, r) => {
    for (const [k, n] of Object.entries(r.categories || {})) acc[k] = (acc[k] || 0) + n;
    return acc;
  }, {});
  const ranked = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  if (ranked.length) {
    L.push('## HUMAN resolution categories', '');
    for (const [k, n] of ranked) L.push(`- \`${k}\` — ${n}`);
    const [top, n] = ranked[0];
    const total = ranked.reduce((a, [, x]) => a + x, 0);
    L.push('');
    L.push(`Dominant: **${top}** (${n}/${total}). `
      + ({
        coverage_gap: 'The sources cannot reach this era. Adding an archive with pre-2000 reach is the next lever, not a looser matcher.',
        ambiguous_source: 'Sources match the words but not the event. The context gates are the module to tighten.',
        wrong_extraction: 'The extractor is pulling values out of sentences that do not contain them. Fix extraction first.',
        different_event: 'Briefs are carrying more than one occurrence. This is queue editorial, not a verifier fault.',
        wrong_entity: 'The pins are wrong. Re-run the identity pass before anything else.'
      }[top] || 'No standing guidance for this category yet.'));
    L.push('');
  }

  if (crossChecks.length) {
    L.push('## Cross-check disagreements (brief vs Wikidata)', '');
    for (const c of crossChecks) {
      L.push(`- **${c.id}** ${c.claim_type}: brief says \`${c.brief}\`, ${c.from} says \`${c.entity}\``);
    }
    L.push('');
  }

  if (anomalies.length) {
    L.push('## Extraction anomalies', '');
    for (const a of anomalies) L.push(`- **${a.id}** — ${a.text}`);
    L.push('');
  }

  // What the death-lexicon gate refused. A gate nobody can audit is a gate
  // nobody can trust: if it ever starts eating true claims, it shows up here
  // first, with the sentence it refused.
  const drops = done.flatMap((r) => (r.lexiconDrops || []).map((d) => ({ ...d, id: r.id })));
  L.push('## Claims dropped by the lexicon gate', '');
  if (!drops.length) L.push('None — no numeric toll was found outside a sentence about deaths.');
  for (const d of drops) {
    L.push(`- **${d.id}** ${d.claim_type} \`${d.value}\` — ${d.reason}`);
    L.push(`  > ${d.sentence}`);
  }
  L.push('');

  const idBlocks = done.filter((r) => (r.identity || []).length);
  if (idBlocks.length) {
    L.push('## Identity blocks', '');
    for (const r of idBlocks) for (const p of r.identity) L.push(`- **${r.id}** — ${p}`);
    L.push('');
  }

  // The real split. "0 captured" once looked like a dead archive when it was
  // only throttling, so no-capture, fetch-error and rate-limited stay apart.
  const wb = done.reduce((acc, r) => {
    for (const k of Object.keys(acc)) acc[k] += r.wayback?.[k] || 0;
    return acc;
  }, { captured: 0, no_capture: 0, fetch_error: 0, rate_limited: 0 });
  const sampled = Object.values(wb).reduce((a, b) => a + b, 0);
  L.push('## Endpoint outcomes', '');
  L.push(`Wayback, ${sampled} reference(s) sampled — ${wb.captured} captured · ${wb.no_capture} no capture · `
    + `${wb.fetch_error} fetch error · ${wb.rate_limited} rate-limited`);
  if (wb.rate_limited > wb.captured && sampled) {
    L.push('');
    L.push('**Rate-limited outnumbers captured — treat this run\'s archive coverage as unmeasured, not absent.**');
  }
  L.push('');

  if (failed.length) {
    L.push('## Errored', '');
    for (const r of failed) L.push(`- **${r.id}** — ${r.error}`);
    L.push('');
  }

  // Anniversaries are a build signal, not a publish one: the lead time exists
  // so a file is finished and reviewed before the date, not scrambled on it.
  if (due.length) {
    L.push('## Anniversaries due', '');
    for (const { t, days } of due) {
      const years = t.anniversaryYear ? `${new Date().getUTCFullYear() - Number(t.anniversaryYear)}th` : '';
      L.push(`- **${days === 0 ? 'TODAY' : `T-${days}`}** · ${t.anniversary} · \`${t.lane || 'football'}\` — `
        + `${t.topic} ${years ? `(${years} anniversary)` : ''}`);
    }
    L.push('');
    L.push('Build now, publish on the date.');
    L.push('');
  }

  // The engine auditing itself. It may fix its own proposals before a human
  // sees them; it may not do so quietly.
  L.push('## Engine corrections since the last digest', '');
  if (!corrections.length) L.push('None — the engine did not revise any of its own output.');
  for (const c of corrections) {
    L.push(`- **${c.topic_id}** \`${c.field}\`: \`${c.before}\` → \`${c.after}\``);
    L.push(`  ${c.reason}`);
  }
  L.push('');

  L.push('---', '', 'Every topic in this ledger remains `approved:false`. Nothing here renders or publishes.', '');
  return L.join('\n');
}

async function main() {
  const startedAt = Date.now();
  const args = process.argv.slice(2);
  const get = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
  const dryRun = args.includes('--dry-run');
  const only = get('--topic');
  const limit = Number(get('--limit', '0')) || 0;
  const fresh = args.includes('--fresh');   // ignore tonight's checkpoint

  const queue = JSON.parse(await fsp.readFile(QUEUE_PATH, 'utf8'));
  let topics = queue.topics.filter(isBuildable);
  if (only) topics = topics.filter((t) => t.id === only);
  if (limit) topics = topics.slice(0, limit);
  if (!topics.length) throw new Error(only ? `no topic "${only}" in the queue` : 'no topics to verify');

  logger.info(`${topics.length} topic(s), sequential${dryRun ? ', dry run' : ''}`);

  const sql = dryRun ? null : db();
  const reports = [];
  let guard = { ok: true, before: 0, after: 0 };

  try {
    const before = sql ? await approvedSet(sql) : new Set();

    // A run started today resumes; a run from an earlier day starts clean, so
    // a stale checkpoint can never masquerade as tonight's verification.
    const today = new Date().toISOString().slice(0, 10);
    const saved = await loadProgress();
    const progress = saved.startedAt?.slice(0, 10) === today && !fresh
      ? saved
      : { startedAt: new Date().toISOString(), reports: {} };
    const resumed = topics.filter((t) => progress.reports[t.id]).length;
    if (resumed) logger.info(`resuming — ${resumed}/${topics.length} topic(s) already done tonight`);

    for (const [i, entry] of topics.entries()) {
      if (progress.reports[entry.id]) {
        reports.push(progress.reports[entry.id]);
        logger.info(`[${i + 1}/${topics.length}] ${entry.id} — checkpointed, skipping`);
        continue;
      }
      logger.info(`[${i + 1}/${topics.length}] ${entry.id}`);
      let report;
      try {
        report = await verifyTopic(sql, entry, { dryRun });
      } catch (error) {
        // One topic failing must not cost the other thirty their run.
        logger.warn(`   ${entry.id} errored: ${error.message}`);
        report = { id: entry.id, error: String(error.message).slice(0, 160) };
      }
      reports.push(report);
      progress.reports[entry.id] = report;
      await saveProgress(progress);
    }

    if (sql) {
      const after = await approvedSet(sql);
      const added = [...after].filter((id) => !before.has(id));
      guard = { ok: added.length === 0, before: before.size, after: after.size, added };
      if (!guard.ok) logger.error(`APPROVAL GUARD FAILED — this run approved: ${added.join(', ')}`);
    }
  } finally {
    if (sql) await sql.end({ timeout: 5 }).catch(() => {});
  }

  // Corrections logged since the previous digest ran.
  const since = await fsp.readFile(path.join(ROOT, DATA_ROOT, 'verify', '.last-digest'), 'utf8')
    .catch(() => '1970-01-01T00:00:00.000Z');
  const log = await fsp.readFile(path.join(ROOT, DATA_ROOT, 'corrections.json'), 'utf8')
    .then(JSON.parse).catch(() => ({ entries: [] }));
  const corrections = (log.entries || []).filter((c) => c.at > since.trim());

  const due = anniversariesDue(queue).map(({ t, days }) => ({ t, days }));
  const digest = digestFor(reports, guard, startedAt, corrections, due);
  await fsp.mkdir(DIGEST_DIR, { recursive: true });
  const out = path.join(DIGEST_DIR, `digest-${new Date().toISOString().slice(0, 10)}.md`);
  await fsp.writeFile(out, digest);
  await fsp.writeFile(path.join(DIGEST_DIR, '.last-digest'), new Date().toISOString());

  const blocked = reports.filter((r) => r.blocked).length;
  const errored = reports.filter((r) => r.error).length;
  logger.info('');
  logger.info(`${reports.length} topic(s): ${reports.length - blocked - errored} clear, ${blocked} blocked, ${errored} errored`);
  logger.success(`digest -> ${out}`);

  // A failed guard is the one thing that must be impossible to miss.
  if (!guard.ok) process.exit(2);
  return reports;
}

if (require.main === module) {
  main().catch((error) => {
    logger.error(`nightly-verify failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { digestFor };
