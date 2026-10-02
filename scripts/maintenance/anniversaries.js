#!/usr/bin/env node
/**
 * ANNIVERSARY ENGINE — turn the queue into a calendar.
 *
 *   node scripts/anniversaries.js --sync     # copy P570/P585 dates into the queue
 *   node scripts/anniversaries.js --check    # what is due within the lead time
 *   node scripts/anniversaries.js --calendar # the whole year, in date order
 *
 * Deaths and disasters get predictable search spikes on their anniversaries —
 * Ibrox on 2 January, Hillsborough on 15 April, Kobe Bryant on 26 January. The
 * dates are already verified: they are the same P570 and P585 values the
 * identity checks and the cross-check run on. Nothing new is asserted here,
 * only copied from the pinned entity onto the topic that uses it.
 *
 * The lead time is two days, which is a publishing decision rather than a
 * technical one: a file has to exist and be reviewed BEFORE the date, not on
 * it. A topic flagged here is a topic to build now, not to publish now.
 *
 * This reads the pin and never writes one. A topic with no entity_qid gets no
 * anniversary, because the date would then come from prose rather than from a
 * verified property — which is the whole failure this layer exists to prevent.
 */

require('dotenv').config();

const fsp = require('fs').promises;
const path = require('path');
const { fetchEntity } = require('../../utils/source-layer');
const { isBuildable, laneOf } = require('../../utils/lanes');
const { Logger } = require('../../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const DATA_ROOT = process.env.DATA_ROOT || 'data';
const QUEUE_PATH = path.join(ROOT, DATA_ROOT, 'queue.json');
const logger = new Logger('Anniversaries');

const LEAD_DAYS = 2;
const pace = (ms = 1100) => new Promise((r) => setTimeout(r, ms));

/** Wikidata times look like +2020-01-26T00:00:00Z. Month and day only. */
function monthDay(time) {
  const m = /^[+-]?\d{4}-(\d{2})-(\d{2})/.exec(String(time || ''));
  if (!m || m[1] === '00' || m[2] === '00') return null;   // a year-only date has no anniversary
  return `${m[1]}-${m[2]}`;
}

function yearOf(time) {
  const m = /^([+-]?\d{4})/.exec(String(time || ''));
  return m ? m[1].replace('+', '') : null;
}

/** Days from today until the next occurrence of MM-DD, 0 when it is today. */
function daysUntil(mmdd, today = new Date()) {
  const [mm, dd] = String(mmdd).split('-').map(Number);
  const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

  let next = Date.UTC(today.getUTCFullYear(), mm - 1, dd);
  if (next < now) next = Date.UTC(today.getUTCFullYear() + 1, mm - 1, dd);
  return Math.round((next - now) / 86400000);
}

async function sync(queue) {
  let written = 0;
  let skipped = 0;

  for (const t of queue.topics.filter(isBuildable)) {
    if (!t.entity_qid) { skipped++; continue; }
    if (t.anniversary && t.anniversarySource) continue;     // already carried over

    let entity = null;
    try { entity = await fetchEntity(t.entity_qid); } catch (error) {
      logger.warn(`${t.id}: ${String(error.message).slice(0, 60)}`);
    }
    await pace();
    if (!entity) continue;

    // A person's anniversary is their death; an event's is the event.
    const source = entity.deathDate[0] ? 'P570' : entity.pointInTime[0] ? 'P585' : null;
    const time = entity.deathDate[0] || entity.pointInTime[0];
    const md = monthDay(time);
    if (!md) {
      logger.info(`  ${t.id.padEnd(14)} no day-level date on ${t.entity_qid} — no anniversary`);
      continue;
    }

    t.anniversary = md;
    t.anniversaryYear = yearOf(time);
    t.anniversarySource = `${source} on ${t.entity_qid}`;
    written++;
    logger.info(`  ${t.id.padEnd(14)} ${md}  (${source} ${t.anniversaryYear})`);
  }

  logger.info('');
  logger.info(`${written} anniversary date(s) copied from verified properties, ${skipped} unpinned topic(s) skipped.`);
  return written;
}

function check(queue, leadDays = LEAD_DAYS) {
  const due = queue.topics
    .filter((t) => isBuildable(t) && t.anniversary)
    .map((t) => ({ t, days: daysUntil(t.anniversary) }))
    .filter((x) => x.days <= leadDays)
    .sort((a, b) => a.days - b.days);

  if (!due.length) {
    logger.info(`nothing within ${leadDays} day(s).`);
    return due;
  }

  for (const { t, days } of due) {
    const when = days === 0 ? 'TODAY' : `T-${days}`;
    const years = t.anniversaryYear ? `${new Date().getUTCFullYear() - Number(t.anniversaryYear)} years` : '';
    logger.warn(`  ${when.padEnd(6)} ${t.anniversary}  ${t.id.padEnd(14)} ${laneOf(t).padEnd(11)} ${years.padEnd(9)} ${t.topic}`);
  }
  return due;
}

function calendar(queue) {
  const rows = queue.topics
    .filter((t) => isBuildable(t) && t.anniversary)
    .sort((a, b) => a.anniversary.localeCompare(b.anniversary));

  for (const t of rows) {
    logger.info(`  ${t.anniversary}  ${String(t.anniversaryYear || '').padEnd(5)} ${t.id.padEnd(14)} ${laneOf(t).padEnd(11)} ${t.topic}`);
  }
  logger.info('');
  logger.info(`${rows.length} dated topic(s), ${queue.topics.filter(isBuildable).length - rows.length} still undated.`);
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const get = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
  const leadDays = Number(get('--lead', String(LEAD_DAYS))) || LEAD_DAYS;
  const queue = JSON.parse(await fsp.readFile(QUEUE_PATH, 'utf8'));

  if (args.includes('--check')) return check(queue, leadDays);
  if (args.includes('--calendar')) return calendar(queue);

  if (args.includes('--sync')) {
    const written = await sync(queue);
    if (written) await fsp.writeFile(QUEUE_PATH, JSON.stringify(queue, null, 2));
    return written;
  }

  throw new Error('usage: --sync | --check [--lead N] | --calendar');
}

if (require.main === module) {
  main().catch((error) => {
    logger.error(`anniversaries failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { monthDay, daysUntil, check, calendar };
