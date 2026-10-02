#!/usr/bin/env node
/**
 * Community post copy + 1080x1080 carousel cards, ready to paste into Studio.
 *
 *   node scripts/make-community-post.js --topic eriksen --dry-run
 *   node scripts/make-community-post.js --topic eriksen --cards "line one|line two"
 *   DATA_ROOT=data/aftercache node scripts/make-community-post.js --topic geocities
 *
 * WHY THIS STOPS SHORT OF POSTING. The YouTube Data API has no community-post
 * resource — channels, channelBanners, channelSections and members are the
 * entire surface, and the third-party "community post" tools on the market only
 * SCRAPE existing posts. So a post cannot be published the way an upload can.
 * This produces finished artefacts; a human pastes them.
 *
 * TWO CARD STYLES, chosen by what the topic actually has.
 *   image - only when a Commons file in data/reference/*archival* matches this
 *           topic by name. Attribution is burned onto the card because CC BY
 *           and CC BY-SA both require it and a carousel is redistribution.
 *   text  - typographic card on a flat background. Used when no licensed image
 *           depicts the subject, which is every AFTER CACHE topic (a dead
 *           website has no Commons photograph).
 *
 * The matcher will not substitute a themed image for a missing one. The pool
 * holds loosely-related scenery — a 1941 street in Port Said sits beside the
 * 2012 Port Said stadium riot — and putting that under the riot's text would
 * assert something false on a channel whose whole claim is that it doesn't.
 * No name match means the text style, not a nearby photo.
 *
 * Text is passed to ffmpeg via `textfile=`, the convention make-top5.js already
 * uses here, so apostrophes and colons in real prose survive instead of being
 * stripped to get past the filter parser.
 */

require('dotenv').config();

const fsp = require('fs').promises;
const path = require('path');
const { runFFmpeg } = require('../../utils/ffmpeg');
const { Logger } = require('../../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const DATA_ROOT = process.env.DATA_ROOT || 'data';
const BRIEF_DIR = path.join(ROOT, 'data', 'research', 'briefs');
const REFERENCE_DIR = path.join(ROOT, 'data', 'reference');
const FONT = 'C:/Windows/Fonts/arialbd.ttf';
const SIZE = 1080;
const logger = new Logger('CommunityPost');

/** Same escaping make-top5.js uses: ffmpeg filter paths need the drive colon escaped. */
function escapeForFilter(filePath) {
  const relative = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
  if (relative && !relative.startsWith('..')) return relative;
  return filePath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');
}

/** Wikipedia leads open with IPA and birth-name asides that read as noise in a post. */
function cleanProse(text) {
  return String(text || '')
    .replace(/\([^)]*pronunciation[^)]*\)/gi, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Hard-wrap for a square card; drawtext renders the newlines as-is. */
function wrap(text, perLine = 24) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (line && (line + ' ' + word).length > perLine) { lines.push(line); line = ''; }
    line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

/**
 * Category nouns, which name the KIND of event rather than this one. Matching on
 * them is how "Bradford City stadium fire" pulled 23 files including Ibrox: every
 * stadium photo contains "stadium". Rarity cannot be used to detect these — in
 * this corpus "stadium" appears in 10% of filenames and "kobe" in 16%, so a
 * frequency threshold cuts the good token and keeps the bad one. The dividing
 * line is grammatical, not statistical, so it is enumerated.
 */
const CATEGORY_WORDS = new Set([
  'stadium', 'disaster', 'city', 'fire', 'riot', 'crash', 'collision', 'sinking',
  'ruling', 'game', 'video', 'online', 'flight', 'mystery', 'final', 'club',
  'football', 'soccer', 'arena', 'park', 'tragedy', 'accident', 'shooting',
  'helicopter', 'match', 'league', 'cup', 'team', 'player'
]);

/**
 * Images whose FILENAME carries this topic's subject. Numeric and short tokens
 * are excluded for the reason pin-identities.js excludes them: "1996" matches
 * every unrelated 1996 file, and "the" matches everything.
 */
async function matchingImages(topicTitle) {
  const tokens = String(topicTitle).toLowerCase().split(/\s+/)
    .map((t) => t.replace(/[^a-z]/g, ''))
    .filter((t) => t.length > 3 && !CATEGORY_WORDS.has(t));
  if (!tokens.length) return [];

  const dirs = (await fsp.readdir(REFERENCE_DIR).catch(() => []))
    .filter((d) => d.includes('archival'));

  const hits = [];
  for (const dir of dirs) {
    const full = path.join(REFERENCE_DIR, dir);
    for (const file of await fsp.readdir(full).catch(() => [])) {
      if (!/\.(jpe?g|png)$/i.test(file)) continue;
      // Whole tokens, not substrings: "support_for_Fabrice_Muamba" and
      // "Portada_de_la_Universidad" both CONTAIN "port", and both turned up
      // under the Port Said riot until this compared words instead.
      const words = new Set(file.toLowerCase().split(/[^a-z]+/).filter(Boolean));
      if (!tokens.some((t) => words.has(t))) continue;
      const meta = await fsp.readFile(path.join(full, `${file}.json`), 'utf8')
        .then(JSON.parse).catch(() => ({}));
      hits.push({
        file: path.join(full, file),
        artist: meta.artist || null,
        license: meta.license || null,
        source: meta.descriptionUrl || null
      });
    }
  }
  return hits;
}

/** Attribution CC BY/BY-SA actually require: who made it, under what licence. */
const attributionLine = (img) => [img.artist, img.license].filter(Boolean).join(' / ');

async function buildCard({ image, text, attribution, outPath }) {
  const textFile = `${outPath}.txt`;
  // A text card carries the whole frame, so it gets bigger type on a shorter
  // measure. Over a photo the words are a caption and stay out of the picture's
  // way. Same copy, two different jobs.
  const wrapped = wrap(text, image ? 24 : 16);
  await fsp.writeFile(textFile, wrapped);

  const font = escapeForFilter(FONT);
  const lineCount = wrapped.split('\n').length;

  if (image) {
    // The scrim has to grow with the copy. At a fixed height a five-line card
    // puts its first line above the dark band, on bare photo, where white text
    // on a pale sky is unreadable.
    const scrimH = Math.min(SIZE, lineCount * 74 + (attribution ? 170 : 120));
    const draw = [
      `drawtext=fontfile='${font}':textfile='${escapeForFilter(textFile)}':`
        + `fontcolor=white:fontsize=58:line_spacing=14:borderw=5:bordercolor=black:`
        + `x=64:y=h-text_h-${attribution ? 120 : 80}`
    ];
    if (attribution) {
      const creditFile = `${outPath}.credit.txt`;
      await fsp.writeFile(creditFile, attribution.slice(0, 70));
      draw.push(`drawtext=fontfile='${font}':textfile='${escapeForFilter(creditFile)}':`
        + `fontcolor=white@0.7:fontsize=22:borderw=3:bordercolor=black:x=64:y=h-56`);
    }
    // A flat scrim rather than a gradient: one filter, always renders, and
    // white text over a bright sky is the failure worth preventing.
    const vf = [
      `scale=${SIZE}:${SIZE}:force_original_aspect_ratio=increase`,
      `crop=${SIZE}:${SIZE}`,
      `drawbox=x=0:y=${SIZE - scrimH}:w=${SIZE}:h=${scrimH}:color=black@0.58:t=fill`,
      ...draw
    ].join(',');
    await runFFmpeg(['-y', '-i', image, '-vf', vf, '-frames:v', '1', outPath]);
  } else {
    // Centred and large enough to fill the square. Bottom-anchored 58px text on
    // an empty black card leaves two thirds of the frame dead, which is the
    // flat look this channel's first cut was rejected for.
    const size = lineCount > 4 ? 64 : 82;
    const vf = [
      `drawtext=fontfile='${font}':textfile='${escapeForFilter(textFile)}':`
        + `fontcolor=white:fontsize=${size}:line_spacing=20:`
        + `x=(w-text_w)/2:y=(h-text_h)/2`,
      // A hairline rule under the block so the card reads as designed rather
      // than as a screenshot of text.
      `drawbox=x=(iw-160)/2:y=ih-150:w=160:h=5:color=0xE04A3F:t=fill`
    ].join(',');
    await runFFmpeg([
      '-y', '-f', 'lavfi', '-i', `color=c=0x0E0E14:s=${SIZE}x${SIZE}`,
      '-vf', vf, '-frames:v', '1', outPath
    ]);
  }

  await fsp.unlink(textFile).catch(() => {});
  await fsp.unlink(`${outPath}.credit.txt`).catch(() => {});
}

async function main() {
  const args = process.argv.slice(2);
  const get = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
  const topic = get('--topic');
  const dryRun = args.includes('--dry-run');
  if (!topic) throw new Error('usage: --topic <brief id> [--cards "a|b|c"] [--dry-run]');

  // The clips channel has no Wikipedia briefs — it runs on streamer clips, not
  // researched topics — so --title stands in for one. Without either, there is
  // no verified subject and the post has nothing to stand on.
  const title = get('--title');
  const brief = await fsp.readFile(path.join(BRIEF_DIR, `${topic}.json`), 'utf8')
    .then(JSON.parse).catch(() => (title ? { title, url: '', text: '' } : null));
  if (!brief) throw new Error(`no brief for "${topic}" and no --title — nothing verified to post about`);

  const images = await matchingImages(brief.title);
  const style = images.length ? 'image' : 'text';

  // Supplied copy wins. The fallback is the title plus the first real sentence,
  // which is serviceable but rarely a hook — pass --cards for anything public.
  const supplied = get('--cards');
  const cards = supplied
    ? supplied.split('|').map((s) => s.trim()).filter(Boolean)
    : [brief.title, cleanProse(brief.text).split(/(?<=[.!?])\s/)[0] || brief.title];

  // The last card always asks something. Community posts earn reach through
  // comments, and a post that asks nothing gets none.
  const question = get('--question', 'Had you heard of this one? Tell me below.');
  cards.push(question);

  logger.info(`${topic} — "${brief.title}"`);
  logger.info(`  style: ${style}${images.length ? ` (${images.length} matching image(s))` : ' (no licensed image depicts this subject)'}`);
  for (const [i, c] of cards.entries()) logger.info(`  card ${i + 1}: ${c.slice(0, 60)}`);

  if (dryRun) { logger.info('Dry run — nothing written.'); return null; }

  const outDir = path.join(ROOT, DATA_ROOT, 'community', topic);
  await fsp.mkdir(outDir, { recursive: true });

  const used = [];
  for (const [i, text] of cards.entries()) {
    const img = images.length ? images[i % images.length] : null;
    const outPath = path.join(outDir, `card-${i + 1}.png`);
    await buildCard({
      image: img ? img.file : null,
      text,
      attribution: img ? attributionLine(img) : null,
      outPath
    });
    if (img) used.push(img);
  }

  const credits = [...new Set(used.map((u) => `${path.basename(u.file)} — ${attributionLine(u)}`))];
  // Blank spacers cannot live in this list: filter(Boolean) ate them and the
  // post came out as one unbroken block. Drop empty PARTS, then join with the
  // blank line between them.
  const post = [
    brief.title,
    cards[0] || '',
    question,
    credits.length ? `Images via Wikimedia Commons:\n${credits.join('\n')}` : '',
    brief.url ? `Source: ${brief.url}` : ''
  ].filter(Boolean).join('\n\n');
  await fsp.writeFile(path.join(outDir, 'post.txt'), post);

  logger.success(`${cards.length} card(s) + post.txt -> ${outDir}`);
  logger.info('The API cannot publish these. Studio > Content > Posts > Create post.');
  return { outDir, cards: cards.length, style };
}

if (require.main === module) {
  main().catch((error) => {
    logger.error(`make-community-post failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { wrap, cleanProse, matchingImages, main };
