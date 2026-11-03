#!/usr/bin/env node
/**
 * Which channels are still short of today's story shorts, from the committed
 * state rather than one run's log.
 *
 *   node scripts/autopilot/day-check.js     # prints "Football Files: 1 of 3 posted", one line per short channel
 *   node scripts/autopilot/day-check.js --ref cloud/main   # the same, from a fetched branch (the PC watchdog)
 *
 * The workflow runs several times a day and only the first run that gets
 * through does the posting, so "this run posted nothing" says nothing about
 * the day (the 2026-11-02 backup run opened a false alarm exactly that way).
 * The state every run commits is what knows. Prints nothing when every
 * channel has its day.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { LANES } = require('./lanes');

const ROOT = path.join(__dirname, '..', '..');
const today = new Date().toISOString().slice(0, 10);
const ref = process.argv.includes('--ref') ? process.argv[process.argv.indexOf('--ref') + 1] : null;

const readState = (lane) => {
  const rel = path.posix.join(lane.dataRoot, 'autopilot.json');
  return ref
    ? execFileSync('git', ['show', `${ref}:${rel}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    : fs.readFileSync(path.join(ROOT, rel), 'utf8');
};

for (const lane of LANES) {
  const quota = lane.storyShortsPerDay ?? 0;
  if (!quota) continue;
  let history = [];
  try {
    history = JSON.parse(readState(lane)).history || [];
  } catch {}
  const posted = history.filter((h) => ['story', 'sequel', 'series'].includes(h.event) && String(h.at).startsWith(today)).length;
  if (posted < quota) console.log(`${lane.name}: ${posted} of ${quota} posted`);
}
