/**
 * The music bed for story shorts: real tracks by Kevin MacLeod
 * (incompetech.com, Creative Commons Attribution 4.0), replacing the
 * synthesised drone in compose_short.py. CC BY means the description must
 * carry the credit line this returns; story-short.js writes it there.
 *
 * Downloaded once into data/music (cached by the workflows). Any failure
 * returns null and the short keeps the synthesised bed, so music never
 * costs a post.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const CACHE = path.join(__dirname, '..', 'data', 'music');
const BASE = 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/';

// Picked for a voice-led documentary short: steady tension, no vocals, no
// big quiet intro. Football is driving and dark; ancient is epic and modal.
const TRACKS = {
  football: ['Volatile Reaction', 'Movement Proposition', 'Impact Prelude', 'Hitman', 'Killers'],
  ancient: ['Five Armies', 'Clash Defiant', 'Heroic Age', 'Curse of the Scarab', 'Rites']
};

const credit = (title) => `Music: "${title}" by Kevin MacLeod (incompetech.com)\n`
  + 'Licensed under Creative Commons: By Attribution 4.0 — https://creativecommons.org/licenses/by/4.0/';

// The same short always gets the same track (seeded on its file name).
function pickIndex(seed, n) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) % n;
}

async function pickTrack(look, seed, logger = console) {
  if (process.env.MUSIC === 'synth') return null;
  const list = TRACKS[look] || TRACKS.football;
  const title = list[pickIndex(seed, list.length)];
  const file = path.join(CACHE, `${title.replace(/[^A-Za-z0-9]+/g, '-')}.mp3`);
  try {
    if (!(fs.existsSync(file) && fs.statSync(file).size > 500000)) {
      await fsp.mkdir(CACHE, { recursive: true });
      const res = await fetch(BASE + encodeURIComponent(title) + '.mp3', {
        headers: { 'User-Agent': 'Mozilla/5.0 (youtube-automation-engine music cache)' },
        signal: AbortSignal.timeout(60000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 500000) throw new Error(`only ${buf.length} bytes`);
      await fsp.writeFile(file, buf);
    }
    return { path: file, title, credit: credit(title) };
  } catch (e) {
    logger.warn?.(`music: "${title}" unavailable (${e.message}); using the synthesised bed`);
    return null;
  }
}

module.exports = { pickTrack, TRACKS };
