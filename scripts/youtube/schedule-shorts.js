#!/usr/bin/env node
/**
 * Spread every private short across a window, so they do not all land at once.
 *
 *   node scripts/schedule-shorts.js --hours 8
 *   node scripts/schedule-shorts.js --hours 8 --dry-run
 *   DATA_ROOT=data/clips-channel node scripts/schedule-shorts.js --hours 8
 *
 * This only stamps `scheduledPublishAt` on the ledger. The actual flip to
 * public is check-scheduled.js, which has to be running on a timer — a
 * schedule nobody wakes up to honour is just a field in a JSON file.
 *
 * WHY NOT YOUTUBE'S OWN publishAt. Setting privacyStatus 'private' together
 * with publishAt does not mean private on YouTube; it means "public at that
 * timestamp", and there is no way to cancel it if the render turns out wrong.
 * Keeping the schedule on this side means a bad short can still be stopped
 * right up until it goes out.
 *
 * The first slot is deliberately NOW, not now-plus-one-interval: there is no
 * reason to make the first video wait when the queue is already rendered.
 */

require('dotenv').config();

const fsp = require('fs').promises;
const path = require('path');
const { Logger } = require('../../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const DATA_ROOT = process.env.DATA_ROOT || 'data';
const LEDGER_PATH = path.join(ROOT, DATA_ROOT, 'shorts', 'uploads.json');
const logger = new Logger('ScheduleShorts');

async function main() {
  const args = process.argv.slice(2);
  const get = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
  const hours = Number(get('--hours', '8')) || 8;
  const dryRun = args.includes('--dry-run');

  const ledger = JSON.parse(await fsp.readFile(LEDGER_PATH, 'utf8').catch(() => '{}'));

  // Only unscheduled private shorts. Re-running must not shuffle a schedule
  // that is already half spent.
  const pending = Object.entries(ledger)
    .filter(([, v]) => v.privacyStatus === 'private' && v.videoId && !v.scheduledPublishAt)
    .sort((a, b) => String(a[1].uploadedAt || '').localeCompare(String(b[1].uploadedAt || '')));

  if (!pending.length) {
    logger.info('nothing private and unscheduled in this ledger.');
    const already = Object.entries(ledger).filter(([, v]) => v.scheduledPublishAt && v.privacyStatus === 'private');
    for (const [id, v] of already) logger.info(`  already scheduled: ${id} -> ${v.scheduledPublishAt}`);
    return null;
  }

  // Even spacing across the window, first one immediately.
  const stepMs = pending.length > 1 ? (hours * 3600 * 1000) / (pending.length - 1) : 0;
  const start = Date.now();

  logger.info(`${pending.length} short(s) across ${hours}h — one every ${Math.round(stepMs / 60000)} min`);
  for (const [i, [id, entry]] of pending.entries()) {
    const when = new Date(start + i * stepMs).toISOString();
    logger.info(`  ${when.slice(0, 16).replace('T', ' ')}  ${id}`);
    if (!dryRun) entry.scheduledPublishAt = when;
  }

  if (dryRun) {
    logger.info('Dry run — ledger untouched.');
    return null;
  }

  await fsp.writeFile(LEDGER_PATH, JSON.stringify(ledger, null, 2));
  logger.success(`scheduled -> ${LEDGER_PATH}`);
  logger.info('check-scheduled.js must be on a timer for these to actually publish.');
  return pending.length;
}

if (require.main === module) {
  main().catch((error) => {
    logger.error(`schedule-shorts failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { main };
