#!/usr/bin/env node
/**
 * A 1280x720 thumbnail for a compilation: its strongest photograph, darkened,
 * with a few huge words over it.
 *
 *   node scripts/autopilot/make-thumbnail.js <dataRoot> <compilationId> [out.jpg]
 *
 * The photograph comes from the LAST segment because compilations are ordered
 * weakest to strongest, so the last story is the one people recognise. The
 * words are the definition's `thumb` (written by the planner) or, for older
 * definitions without one, the title with "Every" style filler stripped.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..', '..');
const W = 1280;
const H = 720;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Break into at most three lines of roughly equal length. */
function lines(text) {
  const words = String(text).toUpperCase().split(/\s+/).filter(Boolean);
  const perLine = Math.max(1, Math.ceil(words.length / 3));
  const out = [];
  for (let i = 0; i < words.length; i += perLine) out.push(words.slice(i, i + perLine).join(' '));
  return out.slice(0, 3);
}

async function makeThumbnail(dataRoot, id, outPath) {
  const base = path.join(ROOT, dataRoot);
  // A byte-order mark (PowerShell writes one) makes JSON.parse throw, which
  // silently dropped the thumb words on the first test.
  const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
  const doc = read(path.join(base, 'scripts', `longform_${id}.json`));
  const def = (() => {
    try { return read(path.join(base, 'compilations', `${id}.json`)); } catch { return {}; }
  })();

  const story = doc.sections.filter((s) => !['cold-open', 'outro'].includes(s.id) && s.images?.length);
  const pick = story[story.length - 1] || doc.sections.find((s) => s.images?.length);
  const imgDir = path.join(base, 'reference', `${id}-archival`);
  const image = path.join(imgDir, pick.images[0]);

  const words = def.thumb || doc.title.replace(/^(every|the|how every)\s+/i, '').split(/\s+/).slice(0, 4).join(' ');
  const rows = lines(words);
  // DejaVu Sans Bold capitals run ~0.72 em wide; size the longest line to fit
  // 1,150px so nothing runs off the frame.
  const longest = Math.max(...rows.map((r) => r.length));
  const size = Math.min(140, Math.floor(1150 / (longest * 0.72)));
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity="0.85"/><stop offset="0.75" stop-color="#000" stop-opacity="0.15"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  ${rows.map((r, i) => `<text x="56" y="${170 + i * (size + 18)}" font-family="DejaVu Sans, Arial Black, Arial" font-weight="900" font-size="${size}" fill="${i === rows.length - 1 ? '#FFD400' : '#FFFFFF'}" stroke="#000" stroke-width="6" paint-order="stroke">${esc(r)}</text>`).join('\n  ')}
  <rect x="0" y="${H - 14}" width="${W}" height="14" fill="#C8102E"/>
</svg>`;

  const out = outPath || path.join(base, 'thumbnails', `${id}.jpg`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await sharp(image)
    .resize(W, H, { fit: 'cover', position: 'attention' })
    .modulate({ brightness: 0.8, saturation: 1.15 })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 88 })
    .toFile(out);
  return out;
}

if (require.main === module) {
  const [dataRoot, id, out] = process.argv.slice(2);
  makeThumbnail(dataRoot, id, out)
    .then((p) => console.log(`thumbnail -> ${p}`))
    .catch((e) => { console.error(`make-thumbnail failed: ${e.message}`); process.exit(1); });
}

module.exports = { makeThumbnail };
