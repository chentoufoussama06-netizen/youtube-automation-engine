/* global fetch, AbortSignal, URLSearchParams */
/**
 * Famous subjects a channel has not covered yet, for the story picker (11 Nov
 * 2026: "where the views we used to pull"). Asked from memory, the AI picker
 * kept proposing the same dozen dark football stories (Escobar, Muamba, Best,
 * Munich, Barcelona, Portsmouth, Leeds, Cruyff); once those were told, 10 Nov
 * found almost nothing new and Ancient Untold drifted to a Babylonian king's
 * oasis and "the Renaissance".
 *
 * The bank is every article in the lane's Wikipedia categories (players who
 * died while playing, match fixing, stadium disasters, Roman emperors,
 * battles of the Republic ...), ranked by how many people read it a month
 * (the Wikimedia pageviews API, free, no key). Built every two weeks into
 * state/<lane>/story-bank.json; the picker gets the most-read untold ones.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const UA = { 'User-Agent': 'yt-automation-research/1.0 (personal project; story bank)' };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ij/g, 'y');

// Per channel: the categories whose articles are its kind of story, and how
// widely read an article must be to count as famous.
const BANKS = {
  'Football Files': {
    minViews: 8000,     // Escobar (95% watched) has 10,800 readers a month
    categories: [
      'Association football players who died while playing',
      'Association football controversies',
      'Match fixing in association football',
      'Doping cases in association football',
      'Stadium disasters',
      'Aviation accidents and incidents involving sports teams',
      'Association football hooliganism',
      'Association football riots',
      // the stars: a dark episode from their own article
      'FIFA World Cup Golden Ball winners',
      "Ballon d'Or winners"
    ]
  },
  'Ancient History': {
    minViews: 20000,
    categories: [
      'Roman emperors',
      'Roman emperors killed in battle',
      'Battles involving the Roman Republic',
      'Battles involving ancient Rome',
      'Battles of the Gallic Wars',
      'Sieges involving the Roman Republic',
      'Ancient Greek generals',
      'Pharaohs',
      'Crisis of the Third Century'
    ]
  }
};

async function api(params) {
  // The action API answers an HTML "You are making too many requests" page
  // to a quick burst: paced, and retried with a longer wait.
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`https://en.wikipedia.org/w/api.php?${new URLSearchParams({ format: 'json', ...params })}`, { headers: UA, signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    if (text.startsWith('{')) return JSON.parse(text);
    await pause(5000 * attempt);
  }
  throw new Error('Wikipedia kept refusing');
}

/** Articles of a category, and of its direct subcategories. */
async function members(category, depth = 1) {
  const out = new Set();
  const subs = [];
  let cont;
  do {
    const j = await api({ action: 'query', list: 'categorymembers', cmtitle: `Category:${category}`, cmlimit: '500', cmtype: 'page|subcat', ...(cont ? { cmcontinue: cont } : {}) });
    for (const m of j.query?.categorymembers || []) {
      if (m.ns === 0) out.add(m.title);
      else if (m.ns === 14) subs.push(m.title.replace(/^Category:/, ''));
    }
    cont = j.continue?.cmcontinue;
    await pause(700);
  } while (cont);
  if (depth > 0) {
    for (const s of subs.slice(0, 12)) {
      for (const t of await members(s, depth - 1).catch(() => [])) out.add(t);
    }
  }
  return [...out].filter((t) => !/^(List of|Lists of|Timeline of|Outline of)\b/.test(t));
}

/**
 * Readers a month of up to 50 articles in one request: the action API's
 * pageviews over the last 30 days. One request per article (the REST
 * endpoint, 925 of them) drew a 429 for nearly all (11 Nov).
 * Returns Map(title -> { views, desc }), null for a batch that failed.
 */
async function monthlyViews(titles) {
  const out = new Map();
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    try {
      // The answer holds the views of only part of the batch, with a
      // "continue" for the rest: without it Foé read as 0 (11 Nov).
      let cont = {};
      do {
        const j = await api({ action: 'query', prop: 'pageviews|description', pvipdays: '30', redirects: '1', titles: batch.join('|'), ...cont });
        // a redirected title answers under its target's name
        const back = new Map([...(j.query?.normalized || []), ...(j.query?.redirects || [])].map((r) => [r.to, r.from]));
        for (const p of Object.values(j.query?.pages || {})) {
          if (!p.pageviews) continue;
          // A typical day, not the total: an obscure player read "1,026,258
          // a month" off a few days of bot traffic (11 Nov build).
          const days = Object.values(p.pageviews).filter((v) => v != null).sort((a, b) => a - b);
          const typical = days.length ? days[Math.floor(days.length / 2)] * 30 : 0;
          const entry = { views: typical, desc: String(p.description || '') };
          out.set(p.title, entry);
          if (back.has(p.title)) out.set(back.get(p.title), entry);
        }
        cont = j.continue || null;
        await pause(1200);
      } while (cont);
    } catch { for (const t of batch) if (!out.has(t)) out.set(t, null); }
  }
  return out;
}

/** Build a lane's bank: [{ article, views, from }], most-read first. */
async function buildBank(laneName, logger = console) {
  const spec = BANKS[laneName];
  if (!spec) return [];
  const from = new Map();
  for (const c of spec.categories) {
    try {
      const list = await members(c);
      for (const t of list) if (!from.has(t)) from.set(t, c);
      logger.info?.(`story bank: ${list.length} article(s) in "${c}"`);
    } catch (e) { logger.warn?.(`story bank: "${c}" failed (${String(e.message).slice(0, 80)})`); }
  }
  const views = await monthlyViews([...from.keys()]);
  const failed = [...views.values()].filter((v) => v === null).length;
  // A bank built mostly from failed lookups would hold two names for two weeks.
  if (failed > from.size / 4) throw new Error(`${failed} of ${from.size} readership lookups failed`);
  // A story is a person, a club or an event: not the films, novels and
  // diseases the hooliganism and controversy categories also hold
  // (EuroTrip, Green Street, chronic traumatic encephalopathy).
  const NOT_A_STORY = /\b(film|movie|novel|book|television|tv series|sitcom|documentary|video game|album|song|band|disease|disorder|syndrome|medical condition)\b/i;
  const out = [];
  for (const [article, c] of from) {
    const e = views.get(article);
    if (!e || e.views < spec.minViews || NOT_A_STORY.test(e.desc)) continue;
    out.push({ article, views: e.views, from: c, about: e.desc.slice(0, 80) });
  }
  out.sort((a, b) => b.views - a.views);
  logger.info?.(`story bank: ${out.length} famous of ${from.size} articles for ${laneName}`);
  return out;
}

/**
 * Is a bank article already a story here? Its name (no parentheses) or, for a
 * person, the surname appears in a past story's article, subject or title.
 */
function told(article, past) {
  const name = fold(article.replace(/\([^)]*\)/g, '').trim());
  const last = name.split(/\s+/).pop();
  const person = name.split(/\s+/).length >= 2 && !/\b(disaster|scandal|riot|riots|battle|siege|war|wars|crash|affair|massacre|tragedy|final|cup)\b/.test(name);
  return past.some((p) => {
    const t = fold(`${p.article || ''} | ${p.subject || ''} | ${p.title || ''}`);
    return t.includes(name) || (person && last.length >= 4 && new RegExp(`(^|[^a-z])${last}([^a-z]|$)`).test(t));
  });
}

/**
 * The lane's most-read subjects not told yet: up to `n`, from the bank file,
 * rebuilt when it is missing or two weeks old (and `rebuild` allows it). A
 * build Wikipedia refused is not tried again for a day: it takes ~15 minutes,
 * and Ancient Untold's first one was refused (11 Nov).
 */
async function storyBank(lane, past, { n = 30, rebuild = true, logger = console } = {}) {
  if (!BANKS[lane.name]) return [];
  const file = path.join(ROOT, lane.dataRoot, 'story-bank.json');
  let bank = null;
  try { bank = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { bank = null; }
  const stale = !bank?.builtAt || Date.now() - Date.parse(bank.builtAt) > 14 * 86400000;
  const resting = bank?.failedAt && Date.now() - Date.parse(bank.failedAt) < 86400000;
  if (stale && rebuild && !resting) {
    let entries = [];
    try {
      entries = await buildBank(lane.name, logger);
    } catch (e) {
      logger.warn?.(`story bank: ${e.message}; next try in a day`);
    }
    bank = entries.length ? { builtAt: new Date().toISOString(), entries }
      : { ...(bank || { entries: [] }), failedAt: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(bank, null, 1));
  }
  return (bank?.entries || []).filter((e) => !told(e.article, past)).slice(0, n);
}

module.exports = { storyBank, buildBank, told, BANKS };

// node scripts/autopilot/story-bank.js "Football Files"  -> builds and prints the bank
if (require.main === module) {
  const { LANES } = require('./lanes');
  const lane = LANES.find((l) => l.name === (process.argv[2] || 'Football Files'));
  (async () => {
    const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
    const past = readJson(path.join(ROOT, lane.dataRoot, 'stories.json'), []);
    const ledger = readJson(path.join(ROOT, lane.dataRoot, 'shorts', 'uploads.json'), {});
    for (const v of Object.values(ledger)) if (v.title) past.push({ title: v.title });
    const top = await storyBank(lane, past, { n: 40 });
    for (const e of top) console.log(`${String(e.views).padStart(7)}/mo  ${e.article}  (${e.from})`);
  })();
}
