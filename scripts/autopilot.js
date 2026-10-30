#!/usr/bin/env node
/**
 * One day of the channels, start to finish, with nobody watching.
 *
 *   node scripts/autopilot.js                 # everything below, every lane
 *   node scripts/autopilot.js --lane "AFTER CACHE"
 *   node scripts/autopilot.js --dry-run       # say what would happen, post nothing
 *   node scripts/autopilot.js --save-refs     # push every local photo set to the release
 *   PIN_ARTICLE="Harry Kane" PIN_MOMENT="..." PIN_TITLE="..." node scripts/autopilot.js --lane "Football Files"
 *                                             # post one named story, nothing else
 *
 * Replaces the Reddit-over-gameplay loop in daily.js, which posted 18 shorts
 * for 27 views. Each lane now makes ONE product and feeds it every day:
 *
 *   short    one documentary short a day, cut from a compilation's segments
 *            (make-doc-short.js), titled by a hook written from its own text.
 *   longform the compilation itself, 9-14 minutes, at most one every
 *            LONGFORM_GAP_DAYS, with a generated thumbnail.
 *   supply   when no segment is left to cut, a new compilation is planned
 *            (plan-compilation.js) and built (build-compilation.js), so the
 *            pipeline never runs dry and never repeats a subject.
 *   sequel   a story short that pulled a crowd (autopilot/sequels.js) gets its
 *            Part 2, then Part 3, in the lane's first story slot; each part is
 *            linked from the one before and kept in a series playlist.
 *
 * Every render passes check-video.js before it is uploaded. Anything that fails
 * is skipped and counted; after two failures a segment or compilation is
 * retired rather than retried forever.
 *
 * Photographs are .jpg and therefore outside git; they travel as one tarball
 * per compilation on the `refs` release. Everything else a run learns is in
 * <dataRoot>/autopilot.json and the existing ledgers, committed by the workflow.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { AITextService } = require('../utils/ai-text-service');
const { LANES } = require('./autopilot/lanes');
const { check } = require('./autopilot/check-video');
const { makeThumbnail } = require('./autopilot/make-thumbnail');
const { plan } = require('./autopilot/plan-compilation');
const { makeStoryShort } = require('./autopilot/story-short');
const { pickSequel } = require('./autopilot/sequels');

const ROOT = path.join(__dirname, '..');
const LONGFORM_GAP_DAYS = Number(process.env.LONGFORM_GAP_DAYS) || 2;
const MAX_FAILURES = 2;
const REFS_RELEASE = 'refs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const onlyLane = args.includes('--lane') ? args[args.indexOf('--lane') + 1] : null;

const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
};
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`); };
const log = (...a) => console.log(`[autopilot ${new Date().toISOString().slice(11, 19)}]`, ...a);
const laneSlug = (lane) => lane.dataRoot.split('/').pop();

/** Run a repo script for one lane; returns { ok, out }. */
function run(lane, script, scriptArgs, timeoutMin = 30) {
  log(`$ node ${script} ${scriptArgs.join(' ')}`);
  const res = spawnSync(process.execPath, [path.join(ROOT, script), ...scriptArgs], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_ROOT: lane.dataRoot,
      QUEUE_PATH: path.join(ROOT, lane.dataRoot, 'queue.json'),
      YT_TOKENS_FILE: lane.tokens,
      CATEGORY_ID: lane.categoryId,
      EDGE_TTS_VOICE: lane.voice
    },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: timeoutMin * 60 * 1000
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  process.stdout.write(`${out.split('\n').filter((l) => !/DeprecationWarning|trace-deprecation/.test(l)).join('\n')}\n`);
  return { ok: res.status === 0, out };
}

// ---------------------------------------------------------------- refs release

// The local clone has three remotes, so gh must be told which repo holds the release.
const GH_REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || 'chentoufoussama06-netizen/youtube-automation-engine';

function gh(ghArgs) {
  return spawnSync('gh', ghArgs, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GH_REPO } });
}

function restoreRefs() {
  const tmp = path.join(ROOT, 'data', 'refs-download');
  fs.mkdirSync(tmp, { recursive: true });
  const res = gh(['release', 'download', REFS_RELEASE, '-p', '*.tar.gz', '-D', tmp, '--clobber']);
  if (res.status !== 0) {
    log(`no photo sets restored (${String(res.stderr).trim().slice(0, 120)})`);
    return;
  }
  for (const f of fs.readdirSync(tmp).filter((n) => n.endsWith('.tar.gz'))) {
    spawnSync('tar', ['-xzf', path.join(tmp, f), '-C', ROOT]);
  }
  log(`restored ${fs.readdirSync(tmp).length} photo set(s) from the ${REFS_RELEASE} release`);
}

function saveRefs(lane, compId) {
  const rel = path.posix.join(lane.dataRoot, 'reference', `${compId}-archival`);
  if (!fs.existsSync(path.join(ROOT, rel))) return;
  const tarball = path.join(ROOT, 'data', `${laneSlug(lane)}__${compId}.tar.gz`);
  fs.mkdirSync(path.dirname(tarball), { recursive: true });
  spawnSync('tar', ['-czf', tarball, rel], { cwd: ROOT });
  if (gh(['release', 'view', REFS_RELEASE]).status !== 0) {
    gh(['release', 'create', REFS_RELEASE, '--title', 'Compilation photo sets', '--notes',
      'Commons photographs for each compilation, one tarball per set. Managed by scripts/autopilot.js.']);
  }
  const up = gh(['release', 'upload', REFS_RELEASE, tarball, '--clobber']);
  log(up.status === 0 ? `saved photo set ${compId}` : `could not save photo set ${compId}: ${String(up.stderr).trim().slice(0, 160)}`);
}

// ---------------------------------------------------------------- lane state

const base = (lane, ...p) => path.join(ROOT, lane.dataRoot, ...p);
const stateOf = (lane) => readJson(base(lane, 'autopilot.json'), { longform: {}, failures: {}, history: [] });
const saveState = (lane, st) => { if (!DRY) writeJson(base(lane, 'autopilot.json'), st); };
const ledgerOf = (lane) => readJson(base(lane, 'shorts', 'uploads.json'), {});

/** Compilations with a written script, oldest first. */
function built(lane) {
  const dir = base(lane, 'scripts');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^longform_.+\.json$/.test(f))
    .map((f) => ({ id: f.replace(/^longform_|\.json$/g, ''), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .filter((c) => fs.existsSync(base(lane, 'compilations', `${c.id}.json`)))
    .sort((a, b) => a.mtime - b.mtime)
    .map((c) => c.id);
}

/** Definitions not yet built into a script. */
function unbuilt(lane, st) {
  const dir = base(lane, 'compilations');
  if (!fs.existsSync(dir)) return [];
  const done = new Set(built(lane));
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
    .filter((id) => !done.has(id) && (st.failures[`build:${id}`] || 0) < MAX_FAILURES);
}

/** Segments still waiting to become a short, best first. */
function shortCandidates(lane, st) {
  const ledger = ledgerOf(lane);
  const comps = built(lane);
  // Compilations already live as long-form first: their shorts have somewhere to send people.
  comps.sort((a, b) => Number(!st.longform[a]) - Number(!st.longform[b]));
  const out = [];
  for (const comp of comps) {
    const doc = readJson(base(lane, 'scripts', `longform_${comp}.json`), { sections: [] });
    for (const s of doc.sections) {
      if (['cold-open', 'outro'].includes(s.id) || !s.images?.length) continue;
      if (ledger[s.id] || ledger[`doc-${s.id}`]) continue;
      if ((st.failures[`short:${s.id}`] || 0) >= MAX_FAILURES) continue;
      const imgs = base(lane, 'reference', `${comp}-archival`);
      if (!s.images.every((f) => fs.existsSync(path.join(imgs, f)))) continue;   // photos not restored
      out.push({ comp, seg: s });
    }
  }
  return out;
}

// ---------------------------------------------------------------- steps

/** A Shorts title written from the narration it sits on, and nothing else. */
async function hookFor(ai, text) {
  const prompt = `Write the title for a YouTube Short whose narration is below.

"""
${text}
"""

Rules:
- One sentence, under 70 characters, ending in a full stop, question mark or exclamation mark.
- Use ONLY facts stated in the narration. Name the person, club or event.
- Open a curiosity gap: make the viewer need to know what happened. Do not give away the ending.
- No emojis, no hashtags, no quotation marks, no ALL CAPS words.

Return the title and nothing else.`;
  try {
    let t = String(await ai.generateText(prompt, { maxTokens: 400, temperature: 0.8 }))
      .split('\n').map((l) => l.trim()).find(Boolean) || '';
    t = t.replace(/^["'“”]+|["'“”]+$/g, '').replace(/#\w+/g, '').trim();
    // upload-shorts.js titles the video with the copy's FIRST sentence, so the
    // hook must be exactly one.
    t = t.replace(/([.!?])\s+(?=\S)/g, ', ').replace(/[,;:\s]+$/, '');
    if (!/[.!?]$/.test(t)) t += '.';
    return t.length >= 15 && t.length <= 90 ? t : null;
  } catch {
    return null;
  }
}

async function ensureSupply(lane, st) {
  if (shortCandidates(lane, st).length) return true;
  let pendingDefs = unbuilt(lane, st);
  if (!pendingDefs.length) {
    log(`${lane.name}: out of material — planning a new compilation`);
    if (DRY) return false;
    try {
      const { def } = await plan(lane.name);
      st.history.push({ at: new Date().toISOString(), event: 'planned', id: def.id, title: def.title });
    } catch (error) {
      log(`${lane.name}: planning failed: ${error.message}`);
      return false;
    }
    pendingDefs = unbuilt(lane, st);
  }
  for (const id of pendingDefs) {
    log(`${lane.name}: building compilation ${id}`);
    if (DRY) return false;
    // Wikipedia and Commons drop requests intermittently and the builder caches
    // whatever lands, so a second pass converges where the first fell short.
    let ok = run(lane, 'scripts/production/build-compilation.js', [id], 45).ok;
    if (!ok) ok = run(lane, 'scripts/production/build-compilation.js', [id], 45).ok;
    if (ok) {
      saveRefs(lane, id);
      st.history.push({ at: new Date().toISOString(), event: 'built', id });
      if (shortCandidates(lane, st).length) return true;
    } else {
      st.failures[`build:${id}`] = (st.failures[`build:${id}`] || 0) + 1;
    }
  }
  return shortCandidates(lane, st).length > 0;
}

async function postShort(lane, st, ai) {
  if (!(await ensureSupply(lane, st))) return `${lane.name}: no short (no material)`;

  for (const { comp, seg } of shortCandidates(lane, st).slice(0, 3)) {
    const id = `doc-${seg.id}`;
    const hook = await hookFor(ai, seg.text.split(/\s+/).slice(0, 130).join(' '));
    log(`${lane.name}: short ${id} from ${comp}${hook ? ` — "${hook}"` : ''}`);
    if (DRY) return `${lane.name}: would post short ${id}${hook ? ` "${hook}"` : ''}`;

    const made = run(lane, 'scripts/production/make-doc-short.js', [comp, seg.id, ...(hook ? ['--hook', hook] : [])], 20);
    const video = base(lane, 'shorts', 'video', `${id}_short.mp4`);
    const gate = made.ok && fs.existsSync(video) ? check(video, 'short') : { ok: false, problems: ['render failed'] };
    if (!gate.ok) {
      log(`${lane.name}: ${id} rejected — ${gate.problems.join('; ')}`);
      st.failures[`short:${seg.id}`] = (st.failures[`short:${seg.id}`] || 0) + 1;
      fs.rmSync(video, { force: true });
      continue;
    }

    run(lane, 'scripts/youtube/upload-shorts.js', ['--no-subs', '--limit', '1'], 15);
    if (!ledgerOf(lane)[id]) {
      st.failures[`short:${seg.id}`] = (st.failures[`short:${seg.id}`] || 0) + 1;
      return `${lane.name}: short ${id} rendered but upload failed`;
    }
    run(lane, 'scripts/youtube/upload-shorts.js', ['--publish', id], 10);
    const entry = ledgerOf(lane)[id];
    st.history.push({ at: new Date().toISOString(), event: 'short', id, url: entry.url });
    return `${lane.name}: short ${entry.privacyStatus} ${entry.url} "${entry.title}"`;
  }
  return `${lane.name}: no short (every candidate failed the quality gate)`;
}

/**
 * One famous-player story short: write, render, gate, upload, publish. With
 * `sequelOf`, the next part of that story instead (see autopilot/sequels.js).
 * Returns { ok, uploaded, msg }; `uploaded` says an upload was attempted, so a
 * failure there (usually quota) is not retried with a fresh story.
 */
async function postStoryShort(lane, st, sequelOf = null, pinned = null) {
  const kind = sequelOf ? `Part ${(sequelOf.part || 1) + 1} of ${sequelOf.id}` : 'story short';
  let made;
  try {
    made = await makeStoryShort(lane.name, { dryRun: DRY, sequelOf, story: pinned });
  } catch (error) {
    return { ok: false, msg: `${lane.name}: no ${kind} — ${error.message}` };
  }
  if (DRY) return { ok: true, msg: `${lane.name}: would post ${kind} "${made.title}"` };

  const gate = check(made.video, 'short');
  if (!gate.ok) {
    fs.rmSync(made.video, { force: true });
    return { ok: false, msg: `${lane.name}: ${kind} ${made.id} rejected — ${gate.problems.join('; ')}` };
  }
  run(lane, 'scripts/youtube/upload-shorts.js', ['--no-subs', '--limit', '1'], 15);
  if (!ledgerOf(lane)[made.id]) return { ok: false, uploaded: true, msg: `${lane.name}: ${kind} ${made.id} rendered but upload failed` };
  run(lane, 'scripts/youtube/upload-shorts.js', ['--publish', made.id], 10);
  const entry = ledgerOf(lane)[made.id];
  st.history.push({ at: new Date().toISOString(), event: sequelOf ? 'sequel' : 'story', id: made.id, url: entry.url });
  if (sequelOf) {
    // Linked at the end of the run, once every lane has had its uploads.
    st.pendingLinks = st.pendingLinks || [];
    st.pendingLinks.push({ root: made.root, prev: sequelOf.videoId, next: entry.videoId, part: made.part, subject: sequelOf.subject });
  }
  return { ok: true, msg: `${lane.name}: ${kind} ${entry.privacyStatus} ${entry.url} "${entry.title}"` };
}

/** A story short that pulled a crowd, due its next part today, or null. */
async function sequelDue(lane, st) {
  if (!lane.storyShortsPerDay) return null;
  try {
    const parent = await pickSequel(lane, st);
    if (parent) log(`${lane.name}: ${parent.id} earned a sequel — ${parent.views} views, ${parent.avgPct.toFixed(0)}% watched`);
    return parent;
  } catch (error) {
    // Analytics down or a token without its scope: the day's stories go ahead as usual.
    log(`${lane.name}: sequel check skipped — ${String(error.message).slice(0, 120)}`);
    return null;
  }
}

/**
 * Point each part at the next and gather the series into one playlist. Runs
 * after every lane has posted: these edits draw on the same 10,000-unit quota
 * as the uploads (~200 units to start a series), so they must never cost a
 * post. A link that fails waits in state and is retried on the next run.
 */
function linkSeries(lane, st) {
  const pending = st.pendingLinks || [];
  if (!pending.length || DRY) return [];
  st.series = st.series || {};
  const out = [];
  st.pendingLinks = pending.filter((job) => {
    const series = st.series[job.root] || {};
    const res = run(lane, 'scripts/youtube/link-series.js', [job.prev, job.next, String(job.part),
      ...(series.playlistId ? ['--playlist', series.playlistId] : ['--playlist-title', `${job.subject}: the full story`])], 5);
    // Kept even when the run failed later on, so a retry does not make a second playlist.
    const m = /SERIES_PLAYLIST=([\w-]+)/.exec(res.out);
    if (m) st.series[job.root] = { ...series, playlistId: m[1] };
    if (res.ok) {
      out.push(`${lane.name}: linked Part ${job.part - 1} to Part ${job.part}${m ? `, playlist https://www.youtube.com/playlist?list=${m[1]}` : ''}`);
      return false;
    }
    job.tries = (job.tries || 0) + 1;
    if (job.tries < 5) return true;
    out.push(`${lane.name}: gave up linking Part ${job.part} of ${job.root}`);
    return false;
  });
  return out;
}

// All channels share one Google project's 10,000 units a day. Five shorts
// (≈8,250 with publishes) leave room for exactly one long-form upload.
let longformPostedThisRun = false;

async function postLongform(lane, st) {
  if (longformPostedThisRun) return `${lane.name}: long-form waits a day (one per run keeps the upload quota)`;
  const last =Object.values(st.longform).map((v) => Date.parse(v.uploadedAt)).sort().pop() || 0;
  const days = (Date.now() - last) / 86400000;
  if (days < LONGFORM_GAP_DAYS) return `${lane.name}: long-form resting (${days.toFixed(1)}d since the last)`;

  // A compilation whose photo set never fully restored used to block every
  // later one ("waiting for its photos" from 2026-10-09 on); skip past it.
  const hasPhotos = (id) => {
    const d = readJson(base(lane, 'scripts', `longform_${id}.json`), { sections: [] });
    const dir = base(lane, 'reference', `${id}-archival`);
    return d.sections.every((s) => (s.images || []).every((f) => fs.existsSync(path.join(dir, f))));
  };
  const ready = built(lane).filter((id) => !st.longform[id] && (st.failures[`long:${id}`] || 0) < MAX_FAILURES);
  if (!ready.length) return `${lane.name}: no long-form ready`;
  const comp = ready.find(hasPhotos);
  if (!comp) return `${lane.name}: long-form ${ready.join(', ')} waiting for photos`;
  const doc = readJson(base(lane, 'scripts', `longform_${comp}.json`), { sections: [] });
  log(`${lane.name}: long-form ${comp} — "${doc.title}"`);
  if (DRY) return `${lane.name}: would post long-form ${comp} "${doc.title}"`;

  const fail = (why) => {
    st.failures[`long:${comp}`] = (st.failures[`long:${comp}`] || 0) + 1;
    return `${lane.name}: long-form ${comp} not posted — ${why}`;
  };

  const video = base(lane, 'videos', `${comp}_documentary.mp4`);
  if (!fs.existsSync(video) && !run(lane, 'scripts/production/produce-longform.js', [comp], 120).ok) return fail('render failed');
  if (!fs.existsSync(video)) return fail(`render produced no ${path.basename(video)}`);
  const gate = check(video, 'long');
  if (!gate.ok) return fail(gate.problems.join('; '));

  const up = run(lane, 'scripts/youtube/upload-private.js', ['--compilation', comp, '--public'], 60);
  const m = /watch\?v=([\w-]{11})/.exec(up.out);
  if (!up.ok || !m) return fail('upload failed');

  longformPostedThisRun = true;
  st.longform[comp] = { videoId: m[1], url: `https://www.youtube.com/watch?v=${m[1]}`, title: doc.title, uploadedAt: new Date().toISOString() };
  try {
    const thumb = await makeThumbnail(lane.dataRoot, comp);
    const t = run(lane, 'scripts/youtube/set-thumbnail.js', [m[1], thumb], 5);
    st.longform[comp].thumbnail = t.ok;
  } catch (error) {
    log(`${lane.name}: thumbnail skipped: ${error.message}`);
  }
  st.history.push({ at: new Date().toISOString(), event: 'longform', id: comp, url: st.longform[comp].url });
  fs.rmSync(video, { force: true });
  return `${lane.name}: long-form public ${st.longform[comp].url} "${doc.title}"`;
}

// ---------------------------------------------------------------- main

async function main() {
  const lanes = LANES.filter((l) => !onlyLane || l.name.toLowerCase() === onlyLane.toLowerCase());

  if (args.includes('--save-refs')) {
    for (const lane of lanes) for (const id of built(lane)) saveRefs(lane, id);
    return;
  }

  // One story asked for by name (the workflow's "article" input): post just
  // that on the one lane given, through the same fact-check, gate and upload.
  // Read from the environment so a title like "Ballon d'Or" never meets a shell.
  if (process.env.PIN_ARTICLE) {
    const lane = lanes.length === 1 ? lanes[0] : null;
    if (!lane) throw new Error('a pinned story needs --lane');
    const article = process.env.PIN_ARTICLE.trim();
    const pinned = {
      article,
      subject: (process.env.PIN_SUBJECT || article.replace(/\([^)]*\)/g, '')).trim(),
      moment: String(process.env.PIN_MOMENT || '').trim(),
      title: String(process.env.PIN_TITLE || '').trim()
    };
    if (!pinned.moment || !pinned.title) throw new Error('a pinned story needs a moment and a title');
    const st = stateOf(lane);
    const res = await postStoryShort(lane, st, null, pinned);
    saveState(lane, st);
    console.log('\n=== summary ===');
    console.log(res.msg);
    if (!res.ok) process.exit(1);
    return;
  }

  restoreRefs();
  const ai = new AITextService({});
  const summary = [];

  for (const lane of lanes) {
    log(`=== ${lane.name} ===`);
    const st = stateOf(lane);
    st.history = st.history.slice(-200);

    // Self-heal: a publish that failed silently left a finished short private
    // (Messi, 2026-10-07). Anything this autopilot uploaded that is still
    // private gets published before today's work.
    const stuck = Object.entries(ledgerOf(lane))
      .filter(([id, v]) => /^(story|doc)-/.test(id) && v.privacyStatus === 'private')
      .map(([id]) => id);
    if (stuck.length && !DRY) {
      log(`${lane.name}: publishing ${stuck.length} short(s) left private: ${stuck.join(', ')}`);
      run(lane, 'scripts/youtube/upload-shorts.js', ['--publish', ...stuck], 10);
    }
    // A winner's next part takes the first story slot; if no part survives the
    // fact-check, that slot still gets a fresh story.
    const sequelOf = await sequelDue(lane, st);
    for (let i = 0; i < (lane.storyShortsPerDay ?? 0); i++) {
      try {
        let res = null;
        if (i === 0 && sequelOf) {
          res = await postStoryShort(lane, st, sequelOf);
          if (!res.ok && !res.uploaded) {
            st.failures[`sequel:${sequelOf.id}`] = (st.failures[`sequel:${sequelOf.id}`] || 0) + 1;
            log(`${res.msg}; posting a fresh story instead`);
            res = null;
          }
        }
        summary.push((res || await postStoryShort(lane, st)).msg);
      } catch (error) {
        summary.push(`${lane.name}: story short crashed — ${error.message}`);
      }
      saveState(lane, st);
    }
    for (let i = 0; i < (lane.docShortsPerDay ?? 1); i++) {
      try {
        summary.push(await postShort(lane, st, ai));
      } catch (error) {
        summary.push(`${lane.name}: short crashed — ${error.message}`);
      }
      saveState(lane, st);
    }
    try {
      summary.push(await postLongform(lane, st));
    } catch (error) {
      summary.push(`${lane.name}: long-form crashed — ${error.message}`);
    }
    saveState(lane, st);
  }

  for (const lane of lanes) {
    const st = stateOf(lane);
    try {
      summary.push(...linkSeries(lane, st));
    } catch (error) {
      summary.push(`${lane.name}: series linking crashed — ${error.message}`);
    }
    saveState(lane, st);
  }

  console.log('\n=== summary ===');
  summary.forEach((s) => console.log(s));
}

main().catch((error) => {
  console.error(`autopilot failed: ${error.stack || error.message}`);
  process.exit(1);
});
