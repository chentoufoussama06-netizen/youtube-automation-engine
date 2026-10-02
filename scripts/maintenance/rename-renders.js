#!/usr/bin/env node
/**
 * Give finished renders readable filenames.
 *
 * The pipeline names every output after its internal production id
 * (prod_1788021394637_join2mjiwm_3bpk9ps7thd_final.mp4), which is unique and
 * completely unreadable — with several episodes on disk there is no way to tell
 * which is which without probing each one.
 *
 * This renames by the queue's own metadata instead: <job id>_<title slug>.mp4,
 * e.g. escobar_12-balles-pour-un-but-la-fin-tragique.mp4
 *
 * It deliberately lives outside the render path. assembleVideo() builds its
 * output path from productionData.id and the upload script reads videoPath back
 * out of the queue, so renaming inside the pipeline would mean keeping three
 * places in agreement mid-render. Doing it afterwards, as a separate pass that
 * fixes up queue.json, cannot corrupt a render that is still running.
 *
 *   node scripts/rename-renders.js --dry-run     # show what would change
 *   node scripts/rename-renders.js               # rename every finished job
 *   node scripts/rename-renders.js escobar       # just this one
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const QUEUE_PATH = process.env.QUEUE_PATH || path.join(ROOT, 'data', 'queue.json');
const VIDEO_DIR = path.join(ROOT, 'data', 'videos');

// Combining marks left behind by NFD normalisation.
const DIACRITICS = /[̀-ͯ]/g;

/**
 * Title -> filename-safe slug. Accents are folded rather than stripped so
 * "Andrés" becomes "andres" instead of "andrs", and the result is cut at a word
 * boundary so a name never ends mid-word.
 */
function slugify(title, maxLength = 46) {
  const base = String(title)
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (base.length <= maxLength) return base;

  const cut = base.slice(0, maxLength);
  const lastDash = cut.lastIndexOf('-');
  return (lastDash > maxLength * 0.6 ? cut.slice(0, lastDash) : cut)
    .replace(/-+$/, '')
    // French elisions ("d'Andrés") slug to a standalone "d", so a cut can land
    // on it and leave a name trailing a meaningless letter.
    .replace(/-[a-z]{1,2}$/, '');
}

/**
 * Where does this job's video actually live? Prefer the recorded videoPath, but
 * fall back to matching the production id, since an already-renamed file or a
 * hand-moved one leaves videoPath stale.
 */
function locate(job, files) {
  if (job.videoPath && fs.existsSync(job.videoPath)) return job.videoPath;

  const byId = job.productionId
    && files.find(f => f.startsWith(job.productionId) && f.endsWith('_final.mp4'));
  if (byId) return path.join(VIDEO_DIR, byId);

  const expected = `${job.id}_${slugify(job.title || job.topic)}.mp4`;
  const bySlug = files.find(f => f === expected);
  return bySlug ? path.join(VIDEO_DIR, bySlug) : null;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const only = args.filter(a => !a.startsWith('--'));

  const queue = JSON.parse(await fsp.readFile(QUEUE_PATH, 'utf8'));
  const files = fs.existsSync(VIDEO_DIR) ? await fsp.readdir(VIDEO_DIR) : [];

  let renamed = 0;
  let skipped = 0;

  for (const job of queue.topics) {
    if (only.length && !only.includes(job.id)) continue;
    if (!job.title && !job.topic) continue;

    const current = locate(job, files);
    if (!current) continue;

    const target = path.join(VIDEO_DIR, `${job.id}_${slugify(job.title || job.topic)}.mp4`);

    if (path.resolve(current) === path.resolve(target)) {
      // Already named correctly, but videoPath may still point at the old id.
      if (job.videoPath !== target) {
        job.videoPath = target;
        console.log(`${job.id}: name already correct, repaired videoPath`);
        renamed++;
      } else {
        skipped++;
      }
      continue;
    }

    if (fs.existsSync(target)) {
      console.log(`${job.id}: SKIP — ${path.basename(target)} already exists`);
      skipped++;
      continue;
    }

    console.log(`${job.id}: ${path.basename(current)}`);
    console.log(`      -> ${path.basename(target)}`);

    if (!dryRun) {
      await fsp.rename(current, target);
      job.videoPath = target;
    }
    renamed++;
  }

  if (dryRun) {
    console.log(`\n[dry-run] ${renamed} would be renamed, ${skipped} already fine. Nothing written.`);
    return;
  }

  if (renamed) {
    await fsp.writeFile(QUEUE_PATH, JSON.stringify(queue, null, 2));
  }
  console.log(`\nRenamed ${renamed}, left ${skipped} alone. queue.json videoPath kept in sync.`);
}

main().catch(error => {
  console.error(`Rename failed: ${error.message}`);
  process.exit(1);
});
