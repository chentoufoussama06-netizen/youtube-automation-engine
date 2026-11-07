/**
 * Moving shots for story shorts: short Pexels clips (free licence, no
 * attribution needed, PEXELS_API_KEY) cut in where the narration says a word
 * that a still cannot carry — "scored", "penalty", "the crowd" on a football
 * short, "battle", "legions", "temple" on an ancient one.
 *
 * Never match footage: broadcast clips are Content-ID matched and the
 * reused-content flag is what buried Viral Vault Clip. These are atmosphere
 * shots (a ball hitting a net, a stadium at night, flares, ruins), never
 * presented as the actual goal; the named person's photos still win whenever
 * the narration says the name.
 *
 * Everything here is best effort: no key, no network, no match, and the short
 * renders from its photos exactly as before.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { runFFmpeg } = require('./ffmpeg');

const CACHE = path.join(__dirname, '..', 'temp', 'broll');

// trigger: a spoken word (lower case, punctuation stripped) that calls for the theme.
// allow/deny: tested on the Pexels page slug, which describes the clip — the
// search alone returned "a woman practicing kicking a football" and seagulls.
// Generic atmosphere must not name a country: a "moroccan stadium" clip opened the Spain World Cup part (2026-11-07). Nationality comes only from the story's own team theme.
// Crowds and stands only: "exciting soccer match in packed stadium" put random players in the Real Madrid final part (2026-11-07).
const STADIUM_DENY = /woman|women|girl|kid|child|boy|youth|training|practi[cs]|coach|seagull|beach|futsal|indoor|dome|park|backyard|garden|lawn|street|urban|amateur|toy|dog|table|american|concert|festival|basketball|baseball|empty|cricket|rugby|moroc|maroc|spanish|spain|argentin|brazil|brasil|english|england|french|france|german|portug|ital|mexic|dutch|croat|belgi|turk|egypt|saudi|qatar|indian|india|chinese|china|japan|korea|african|nigeri|ghana|senegal|colombi|urugua|chile|peru|match|players|playing|game|kick|dribbl|tackle|player|team|goalkeeper|striker|flag|flags|scarf|scarves|ultras|tifo/;

const THEMES = {
  football: [
    {
      trigger: /^(scor(e|ed|es|ing)|goals?|header|volley(ed)?|penalty|penalties|hat-?trick|winner|equali[sz]er|strike|struck|finish(ed)?|net(ted)?)$/,
      // Pro atmosphere only. "ball hitting net" and "kick slow motion" came
      // back as park pitches and indoor domes (2026-11-06 preview): a cheap
      // clip hurts more than a photo.
      queries: ['soccer stadium crowd celebrating goal', 'football match packed stadium', 'football fans flares stadium'],
      allow: /stadium|crowd|fans|flare|arena|floodlight|supporters|packed/,
      deny: STADIUM_DENY
    },
    {
      trigger: /^(fans|crowd|supporters|stadium|celebrat(e|ed|ion|ions)|erupted|roar(ed)?|chant(ed|ing)?|bernab[eé]u|anfield|wembley|night)$/,
      queries: ['football fans flares stadium', 'soccer stadium crowd celebrating', 'football stadium night floodlights'],
      allow: /stadium|crowd|fans|flare|arena|floodlight|supporters|packed/,
      deny: STADIUM_DENY
    }
    // 2026-11-07: penalty/save, trophy and coach clip themes were tried and
    // removed the same day: Pexels gave an old man in confetti for "trophy" and
    // a women's amateur huddle for "coach". Stock clips of PEOPLE stand in for
    // the real ones; only stadium atmosphere (no one in particular) is used.
  ],
  ancient: [
    {
      trigger: /^(battles?|army|armies|legions?|soldiers|war|marched|siege|invad(e|ed)|conquer(ed)?|fought)$/,
      queries: ['ancient roman ruins', 'ancient amphitheater ruins', 'roman colosseum'],
      // Roman ruins only in Roman or Greek stories: the Rama (India) preview got a Roman statue
      onlyIf: /rome|roman|romans|caesar|emperor|legion|legions|senate|greek|greece|athens|sparta|spartan|carthage|byzant|constantinople|macedon|alexander|pompeii|gaul/,
      allow: /ancient|roman|ruins?|colosse|amphithea|fortress|castle/,
      deny: /people-walking|tourists?-taking|selfie|wedding|drone-pilot/
    },
    {
      trigger: /^(emperors?|kings?|pharaoh|queen|senat(e|or)|throne|statues?|gods?|temples?|rome|athens|carthage|egypt|city|palace)$/,
      queries: ['ancient marble statue', 'ancient temple columns', 'roman forum ruins'],
      onlyIf: /rome|roman|romans|caesar|emperor|legion|legions|senate|greek|greece|athens|sparta|spartan|carthage|byzant|constantinople|macedon|alexander|pompeii|gaul/,
      allow: /ancient|statue|marble|sculpture|temple|column|forum|ruins?|bust/,
      deny: /people-walking|selfie|wedding|modern/
    }
  ],
  // AFTER CACHE, 2026-11-07: military gear that went mainstream. Pexels
  // soldiers are often airsoft, paintball or costume shoots: kept out by slug.
  military: [
    {
      trigger: /^(soldiers?|troops|army|armies|war|wars|battles?|battlefield|combat|front|trenches|marines|infantry|military|fought|deployed)$/,
      queries: ['soldiers walking military', 'army soldiers silhouette', 'military troops marching'],
      allow: /soldier|military|army|troop|marine|infantry|camouflage|uniform/,
      deny: /airsoft|paintball|toy|kid|child|boy|girl|costume|cosplay|game|gaming|fashion|model|posing|halloween|wedding/
    },
    {
      trigger: /^(pilots?|planes?|aircraft|jets?|bombers?|air|sky|skies|flew|flying|fighter)$/,
      queries: ['fighter jet flying', 'military aircraft sky', 'vintage warplane flying'],
      allow: /jet|aircraft|plane|airplane|fighter|warplane|bomber|air-force|airshow/,
      deny: /toy|model|drone|kid|child|paper|passenger|airport|cabin|interior/
    }
  ],
  // Viral Vault Clip, 2026-11-07: lesser-known shipwrecks.
  sea: [
    {
      trigger: /^(ships?|sank|sink|sinking|sunk|storm|storms|waves?|ocean|sea|seas|voyage|sailed|crew|sailors|hull|lifeboats?|iceberg|capsized|water)$/,
      queries: ['stormy ocean waves', 'dark sea storm waves', 'rough sea waves night'],
      allow: /ocean|sea|wave|storm|stormy|rough|swell|ship/,
      deny: /surf|surfer|beach|swim|bikini|people|person|woman|man|tourist|cruise|yacht|kid|child|pool|sunny|sunset-beach|drone-pilot/
    },
    {
      trigger: /^(wrecks?|wreckage|seabed|seafloor|bottom|divers?|discovered|found|deep|depths|remains|sunken)$/,
      queries: ['shipwreck underwater', 'underwater wreck diver', 'deep ocean underwater dark'],
      allow: /wreck|underwater|diver|diving|sunken|seabed|deep|ocean/,
      deny: /pool|swim|bikini|kid|child|aquarium|fish-tank|snorkel|beach/
    }
  ]
};


// Clips of PEOPLE only when they belong to the story (2026-11-07, the user:
// an old fan in a Spain shirt celebrating the World Cup fits a Spain story; a
// random man with a tennis-looking trophy, or a women's amateur huddle, does
// not). So: the clip's own Pexels description must name the team or country
// AND show fans, a flag or a celebration, and it plays on the victory words.
const DEMONYMS = {
  spain: 'spain|spanish|espana', argentina: 'argentin', england: 'england|english', france: 'france|french',
  germany: 'german|deutsch', brazil: 'brazil|brasil', portugal: 'portug', italy: 'ital', morocco: 'morocc|maroc',
  netherlands: 'netherland|dutch|holland', croatia: 'croat', belgium: 'belgi', mexico: 'mexic', usa: 'usa|american-soccer',
  japan: 'japan', 'south korea': 'korea', uruguay: 'urugua', colombia: 'colombia', senegal: 'senegal'
};
const PEOPLE_DENY = /tennis|basketball|baseball|rugby|cricket|american-football|nfl|golf|toy|dog|wedding|birthday|party|office|business|esports|gaming|training|practi|kid|child|school/;
const VICTORY = /^(won|win|wins|victory|champions?|crowned|lifted|lift|trophy|title|celebrat(e|ed|es|ing|ion|ions)|glory|triumph)$/;

/** A clip theme for one team or country, or null when it has no usable name. */
function teamTheme(name) {
  const key = String(name).replace(/\([^)]*\)/g, '').replace(/national (football|soccer) team|f\.?c\.?|c\.?f\.?/gi, '').trim().toLowerCase();
  if (key.length < 3) return null;
  const names = new RegExp(DEMONYMS[key] || key.split(/\s+/).filter((w) => w.length >= 3).join('|'));
  const scene = /fan|celebrat|flag|supporter|crowd|cheer/;
  return {
    team: key,
    trigger: VICTORY,
    queries: [`${key} football fans celebrating`, `${key} flag football fans`, `${key} soccer fans`],
    allow: { test: (slug) => names.test(slug) && scene.test(slug) },
    deny: PEOPLE_DENY,
    landscape: true
  };
}

const bare = (w) => String(w).toLowerCase().replace(/[^a-z0-9'-]/g, '').replace(/'s$/, '');

// A stable pick per short, so a re-render shows the same clips.
function seeded(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0) / 4294967296);
}

async function search(query, key, { landscape = false } = {}) {
  // Team-fan clips are rare (Spain had one, landscape), so those search every
  // orientation and are centre-cropped to 9:16.
  const url = landscape
    ? `https://api.pexels.com/videos/search?per_page=60&query=${encodeURIComponent(query)}`
    : `https://api.pexels.com/videos/search?per_page=30&orientation=portrait&size=medium&query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Authorization: key }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Pexels ${res.status}`);
  return (await res.json()).videos || [];
}

// The smallest portrait file at least 1080 wide (or the largest under it).
function bestFile(v, landscape = false) {
  if (landscape) {
    // tall enough to fill 1920 after the crop with little upscaling
    const any = (v.video_files || []).filter((f) => f.file_type === 'video/mp4' && f.height >= 1080).sort((a, b) => a.height - b.height);
    if (any.length) return any[0];
  }
  const files = (v.video_files || []).filter((f) => f.file_type === 'video/mp4' && f.height > f.width);
  const big = files.filter((f) => f.width >= 1080).sort((a, b) => a.width - b.width);
  return big[0] || files.sort((a, b) => b.width - a.width)[0] || null;
}

async function download(v, file) {
  await fsp.mkdir(CACHE, { recursive: true });
  const out = path.join(CACHE, `${v.id}-${file.width}.mp4`);
  if (fs.existsSync(out) && fs.statSync(out).size > 50000) return out;
  const res = await fetch(file.link, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`clip download ${res.status}`);
  await fsp.writeFile(out, Buffer.from(await res.arrayBuffer()));
  return out;
}

/**
 * Where clips go: [{ at, theme }] for trigger words after the hook, at least
 * 4s apart, at most `max`, never inside a stretch where a name holds the
 * picture (chapters, as resolveChapters returns them).
 */
function clipMoments(words, look, chapters = [], { hookEnd = 2.4, max = 6, extra = [], stock = true } = {}) {
  // A theme with `onlyIf` plays only when the narration matches it.
  const said = words.map((w) => bare(w.word)).join(' ');
  // stock = false: only the story's own themes (its team's fans), no generic crowds
  const themes = [...extra, ...(stock ? THEMES[look] || [] : [])].filter((t) => !t.onlyIf || t.onlyIf.test(said));
  if (!themes.length) return [];
  const named = [];
  chapters.forEach((c, i) => {
    if (!c.photos) return;
    const end = chapters.slice(i + 1).find((x) => x.at > c.at)?.at ?? Infinity;
    // The face shows on the name, then the goal word gets the clip: "Rodrygo
    // struck a volley" is Rodrygo for a beat and the ball on "volley".
    named.push([c.at, Math.min(end, c.at + 1.2)]);
  });
  const out = [];
  for (const w of words) {
    if (w.start < hookEnd + 0.4 || out.length >= max) continue;
    const theme = themes.find((t) => t.trigger.test(bare(w.word)));
    if (!theme) continue;
    if (out.length && w.start - out.at(-1).at < 4) continue;
    if (named.some(([a, b]) => w.start >= a && w.start < b)) continue;
    out.push({ at: w.start, theme });
  }
  return out;
}

/**
 * Splice clips into a v2 shot list. Each clip runs 2.4s from its trigger word
 * (cut to 1080x1920 at 30fps into workDir), across shot boundaries, stopping
 * early where a name takes the picture back; slivers under 0.6s join the clip.
 */
async function addClips(shots, words, { look, chapters = [], hookEnd, workDir, seed, ffmpeg, logger = console, extraThemes = [], stock = true } = {}) {
  const key = process.env.PEXELS_API_KEY;
  if (!key || process.env.BROLL === 'off') return shots;
  const moments = clipMoments(words, look, chapters, { hookEnd, extra: extraThemes, stock });
  if (!moments.length) return shots;

  const rand = seeded(seed);
  const used = new Set();
  const pools = new Map();
  let out = shots.slice();
  let k = 0;
  for (const m of moments) {
    try {
      if (!pools.has(m.theme)) {
        const q = m.theme.queries[Math.floor(rand() * m.theme.queries.length)];
        const found = (await search(q, key, { landscape: Boolean(m.theme.landscape) })).filter((v) => {
          const slug = String(v.url || '').toLowerCase();
          return m.theme.allow.test(slug) && !m.theme.deny.test(slug) && v.duration >= 3 && bestFile(v, Boolean(m.theme.landscape));
        });
        pools.set(m.theme, found);
      }
      const pool = pools.get(m.theme).filter((v) => !used.has(v.id));
      if (!pool.length) continue;
      const v = pool[Math.floor(rand() * Math.min(pool.length, 12))];
      used.add(v.id);
      logger.info?.(`b-roll at ${m.at.toFixed(1)}s (${m.theme.team || look}): ${String(v.url || '').replace(/^https:\/\/www\.pexels\.com\/video\//, '').slice(0, 90)}`);

      // The clip runs 2.4s from the word across shot boundaries, stopping
      // early only where a name takes the picture again or the video ends.
      const total = out.at(-1).end;
      const nextName = chapters.find((c) => c.photos && c.at > m.at + 0.3)?.at ?? Infinity;
      let start = m.at;
      let stop = Math.min(m.at + 2.4, nextName, total);
      const before = out.find((s) => s.start < start && start < s.end);
      if (before && start - before.start < 0.6) start = before.start;
      const after = out.find((s) => s.start < stop && stop < s.end);
      if (after && after.end - stop < 0.6) stop = after.end;
      if (stop - start < 1.2) { logger.info?.(`b-roll: no room at ${m.at.toFixed(1)}s`); continue; }
      const span = stop - start;
      const src = await download(v, bestFile(v, Boolean(m.theme.landscape)));
      const clip = path.join(workDir, `clip${k++}.mp4`);
      const from = Math.max(0, Math.min(v.duration - span - 0.2, v.duration * 0.25));
      await runFFmpeg(['-y', '-ss', from.toFixed(2), '-i', src, '-t', (span + 0.1).toFixed(3), '-an',
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', clip]);

      const r3 = (x) => Number(x.toFixed(3));
      const clipShot = {
        video: clip, image: `clip:${v.id}`, mode: 'bleed', face: null, tight: 1.0,
        start: r3(start), end: r3(stop), zoom: [1.0, 1.06], pan: 0, transition: 'punch', pexels: v.url
      };
      // Shots before and after keep what lies outside the clip.
      const kept = [];
      for (const s of out) {
        if (s.end <= start || s.start >= stop) { kept.push(s); continue; }
        if (s.start < start) kept.push({ ...s, end: r3(start) });
        if (s.end > stop) kept.push({ ...s, start: r3(stop), transition: 'punch' });
      }
      out = [...kept, clipShot].sort((a, b) => a.start - b.start);
    } catch (e) {
      logger.warn?.(`b-roll skipped at ${m.at.toFixed(1)}s: ${e.message}`);
    }
  }
  const n = out.filter((s) => s.video).length;
  if (n) logger.info?.(`b-roll: ${n} clip(s) from Pexels`);
  return out;
}

module.exports = { addClips, clipMoments, THEMES, teamTheme };
