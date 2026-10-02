#!/usr/bin/env node
/**
 * Original documentary graphics: HTML/CSS/SVG -> Playwright -> animated MP4.
 *
 * Every frame this produces is drawn from scratch, so there is nothing to
 * licence and nothing that can be mistaken for archive material. That matters
 * more than it sounds: the Calciopoli script deliberately avoids stock footage
 * at its most important moments, because a generic stadium clip under a legal
 * distinction is exactly how a documentary starts implying things it cannot
 * support.
 *
 * Each graphic is a short looping motion clip, not a still: glass panels over
 * a drifting glow, a staggered entrance, and a type-specific ambient loop
 * (a sweeping clock hand, a drawn-in timeline, a travelling authority pulse
 * through the appointment chain). build-documentary.js already knows how to
 * hold a video clip for an exact segment length (it loops short clips and
 * fades in/out — see its `isVideo` branch), so nothing there needed to change
 * beyond swapping these graphics' extension from .png to .mp4 in SEQUENCE.
 *
 * Frames are captured deterministically rather than recorded in real time:
 * every CSS/Web-Animations timeline on the page is paused immediately, then
 * scrubbed frame-by-frame via `Animation.currentTime` before each screenshot.
 * That is what makes a 29-second held graphic render as 29 seconds of unique
 * motion with no jank, rather than however long Chromium happened to take.
 *
 *   node scripts/build-graphics.js calciopoli
 *
 * Run `node scripts/build-documentary.js <slug> --durations` first so this
 * script can size each clip to its exact on-screen hold time (falls back to
 * a 6s default for any graphic that isn't in SEQUENCE, e.g. spares kept for
 * future documentaries).
 */

const fs = require('fs').promises;
const path = require('path');
const { runFFmpeg } = require('../../utils/ffmpeg');

const ROOT = path.join(__dirname, '..', '..');

// Football Files house style.
const C = {
  bg: '#07070A',
  navy: '#16203A',
  red: '#E23744',
  redDeep: '#C1272D',
  white: '#F4F5F7',
  dim: 'rgba(244,245,247,.56)'
};

const FONT_DISPLAY = "'Anton', 'Arial Narrow', sans-serif";
const FONT_UI = "'Inter', 'Segoe UI', system-ui, sans-serif";
const FONT_LINK = `
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">`;

// Film grain, drawn as SVG noise so no image asset is needed. The seed is
// rewritten from JS before every captured frame (see renderClip) rather than
// animated in CSS/SMIL, so it stays in lockstep with the frame clock instead
// of drifting against it.
const GRAIN = `
<svg class="grain" xmlns="http://www.w3.org/2000/svg">
  <filter id="n"><feTurbulence id="grainTurb" type="fractalNoise" baseFrequency="0.85" numOctaves="3" seed="1"/></filter>
  <rect width="100%" height="100%" filter="url(#n)"/>
</svg>`;

// Three soft glow blobs breathing at different, non-synced periods so the
// ambient background never reads as an obvious loop. Glow-c sits centrally,
// directly behind where .wrap's content lives — without it the corner blobs
// (glow-a/b) never actually reach the middle of the frame, and a glass panel
// blurring plain near-black background just looks like a dark card with a
// border, not glass. The blur needs real colour behind it to reveal.
const GLOW = `
<div class="glow glow-c"></div>
<div class="glow glow-a"></div>
<div class="glow glow-b"></div>
<div class="vignette"></div>`;

const BASE = `
  *{margin:0;padding:0;box-sizing:border-box}
  html{height:100%}
  body{width:100%;height:100%;background:${C.bg};color:${C.white};
       font-family:${FONT_UI};overflow:hidden;position:relative}

  .glow{position:absolute;border-radius:50%;filter:blur(90px);pointer-events:none}
  .glow-c{width:1500px;height:900px;left:50%;top:50%;transform:translate(-50%,-50%);
          background:radial-gradient(ellipse, ${C.navy}ee 0%, ${C.redDeep}3a 46%, transparent 72%);
          animation:breatheC 12s ease-in-out infinite}
  .glow-a{width:900px;height:900px;left:-220px;top:-260px;
          background:radial-gradient(circle, ${C.navy} 0%, transparent 70%);
          animation:breatheA 8s ease-in-out infinite}
  .glow-b{width:760px;height:760px;right:-200px;bottom:-240px;
          background:radial-gradient(circle, ${C.redDeep}55 0%, transparent 70%);
          animation:breatheB 10.5s ease-in-out infinite;animation-delay:-3.4s}
  @keyframes breatheC{0%,100%{transform:translate(-50%,-50%) scale(1);opacity:.7}50%{transform:translate(-50%,-50%) scale(1.08);opacity:1}}
  @keyframes breatheA{0%,100%{transform:scale(1);opacity:.62}50%{transform:scale(1.10);opacity:.95}}
  @keyframes breatheB{0%,100%{transform:scale(1);opacity:.48}50%{transform:scale(1.14);opacity:.85}}
  .vignette{position:absolute;inset:0;box-shadow:inset 0 0 260px 60px ${C.bg};pointer-events:none}
  .grain{position:absolute;inset:0;opacity:.05;pointer-events:none;mix-blend-mode:overlay}

  .wrap{position:relative;width:100%;height:100%;display:flex;flex-direction:column;
        align-items:center;justify-content:center;padding:90px;z-index:2}

  .kicker{font-family:${FONT_UI};font-size:24px;font-weight:800;letter-spacing:.42em;
          color:${C.red};text-transform:uppercase;margin-bottom:44px;text-align:center}
  .title{font-family:${FONT_DISPLAY};font-size:104px;font-weight:400;letter-spacing:.01em;
         text-transform:uppercase;text-align:center;line-height:.98;
         text-shadow:0 20px 60px rgba(0,0,0,.55)}
  .rule{width:120px;height:4px;background:linear-gradient(90deg,${C.red},${C.redDeep});
        margin:40px 0;border-radius:2px;box-shadow:0 0 24px ${C.red}99}
  .note{font-family:${FONT_UI};font-size:21px;font-weight:600;color:${C.dim};
        letter-spacing:.16em;text-transform:uppercase;text-align:center}

  /* Glassmorphic panel: translucent fill + blur over glow-c behind it, a
     bright hairline top-edge highlight, a faint warm inner tint, and a slow
     diagonal sheen sweep. */
  .glass{position:relative;
         background:linear-gradient(155deg, rgba(255,255,255,.16), rgba(255,255,255,.045));
         -webkit-backdrop-filter:blur(34px) saturate(200%);backdrop-filter:blur(34px) saturate(200%);
         border:1px solid rgba(255,255,255,.24);border-radius:28px;
         box-shadow:0 34px 90px -24px rgba(0,0,0,.65), inset 0 1px 0 rgba(255,255,255,.35),
                    inset 0 0 70px rgba(226,55,68,.08);
         overflow:hidden}
  .glass::before{content:'';position:absolute;inset:0;pointer-events:none;
         background:linear-gradient(112deg, transparent 32%, rgba(255,255,255,.16) 48%, transparent 64%);
         background-size:260% 260%;mix-blend-mode:overlay;
         animation:sheen 5.6s ease-in-out infinite}
  @keyframes sheen{0%{background-position:130% 0}100%{background-position:-30% 0}}

  .enter{opacity:0;animation:riseIn .85s cubic-bezier(.16,1,.3,1) forwards}
  @keyframes riseIn{0%{opacity:.4;transform:translateY(14px) scale(.98)}100%{opacity:1;transform:translateY(0) scale(1)}}
  .d0{animation-delay:.02s}.d1{animation-delay:.12s}.d2{animation-delay:.22s}.d3{animation-delay:.32s}
  .d4{animation-delay:.42s}.d5{animation-delay:.52s}.d6{animation-delay:.62s}
`;

function page(inner, extraCss = '') {
  return `<!doctype html><html><head><meta charset="utf-8">${FONT_LINK}<style>${BASE}${extraCss}</style></head>
<body>${GLOW}${GRAIN}<div class="wrap">${inner}</div></body></html>`;
}

// ---------------------------------------------------------------- graphics

function titleCard(kicker, title) {
  return page(`
    <div class="glass card enter d0">
      <div class="kicker enter d1">${kicker}</div>
      <div class="title enter d2">${title}</div>
      <div class="rule enter d3"></div>
    </div>`, `
    .card{padding:90px 130px;display:flex;flex-direction:column;align-items:center;max-width:1520px}`);
}

function appointmentSystem() {
  const nodes = ['FIGC', 'AIA', 'REFEREE<br>COMMISSION', 'DESIGNATORS', 'FIXTURES'];
  const boxes = nodes.map((n, i) => `
    <div class="node glass ${i === 3 ? 'hot' : ''} enter d${Math.min(i, 6)}">${n}</div>
    ${i < nodes.length - 1 ? '<div class="arrow"><span class="pulse"></span></div>' : ''}`).join('');
  return page(`
    <div class="kicker enter d0">How referees were appointed</div>
    <div class="chain">${boxes}</div>
    <div class="note enter d6" style="margin-top:70px">Structure as described in published accounts</div>`, `
    .chain{display:flex;align-items:center;gap:20px}
    .node{padding:34px 24px;min-width:200px;text-align:center;font-family:${FONT_UI};
          font-size:26px;font-weight:800;letter-spacing:.06em;line-height:1.25;border-radius:20px}
    .node.hot{border-color:${C.red}aa;box-shadow:0 0 50px -10px ${C.red}aa, 0 34px 90px -24px rgba(0,0,0,.65);color:#fff}
    .arrow{position:relative;width:34px;height:3px;background:${C.white}22;border-radius:2px}
    .arrow .pulse{position:absolute;left:-10px;top:-3px;width:12px;height:9px;border-radius:5px;
          background:${C.red};box-shadow:0 0 14px ${C.red};animation:flow 2.4s linear infinite}
    @keyframes flow{0%{left:-10px;opacity:0}10%{opacity:1}90%{opacity:1}100%{left:32px;opacity:0}}`);
}

function penaltyStages() {
  const stages = [
    ['Stage 1', 'First sporting ruling'],
    ['Stage 2', 'Appeal'],
    ['Stage 3', 'Later adjustment']
  ];
  const rows = stages.map(([s, l], i) => `
    <div class="row glass enter d${i + 1}">
      <div class="stage">${s}</div>
      <div class="label">${l}</div>
      <div class="redact"><span class="shimmer"></span></div>
    </div>`).join('');
  return page(`
    <div class="kicker enter d0">Points penalties</div>
    ${rows}
    <div class="unver enter d5">Figures unverified</div>`, `
    .row{display:flex;align-items:center;gap:30px;width:1280px;padding:26px 34px;margin-bottom:18px}
    .stage{font-family:${FONT_DISPLAY};font-size:32px;color:${C.red};width:160px;letter-spacing:.05em;
           text-transform:uppercase}
    .label{font-family:${FONT_UI};font-size:28px;font-weight:600;flex:1;letter-spacing:.02em}
    .redact{position:relative;width:240px;height:44px;border-radius:8px;overflow:hidden;
            background:repeating-linear-gradient(90deg,${C.white}1c 0 22px, transparent 22px 30px);
            border:1px solid ${C.white}22}
    .redact .shimmer{position:absolute;top:0;bottom:0;width:60px;
            background:linear-gradient(90deg,transparent,${C.white}40,transparent);
            animation:shimmer 3s ease-in-out infinite}
    @keyframes shimmer{0%{left:-80px}100%{left:280px}}
    .unver{margin-top:38px;font-family:${FONT_UI};font-size:24px;letter-spacing:.3em;color:${C.red};
           text-transform:uppercase;font-weight:800}`);
}

function sportingVsCriminal() {
  const rows = [
    ['Purpose', 'Enforce the sport&rsquo;s own rules', 'Determine criminal liability'],
    ['Procedure', 'Federation tribunals', 'Courts, with appeals'],
    ['Timing', 'Concluded in weeks', 'Ran for years'],
    ['Outcome here', 'Sanctions imposed', 'A more complicated legal outcome']
  ].map(([k, a, b]) => `<div class="k">${k}</div><div class="a">${a}</div><div class="b">${b}</div>`).join('');
  return page(`
    <div class="kicker enter d0">Two separate processes</div>
    <div class="grid glass enter d1">
      <div class="hd"></div><div class="hd sport">Sporting</div><div class="hd crim">Criminal</div>
      ${rows}
    </div>
    <div class="note enter d6" style="margin-top:44px">Neither process is an appeal against the other</div>`, `
    .grid{display:grid;grid-template-columns:230px 1fr 1fr;gap:22px 34px;width:1420px;padding:50px 56px}
    .hd{font-family:${FONT_UI};font-size:26px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;
        padding-bottom:16px;border-bottom:2px solid ${C.white}26}
    .hd.sport{color:${C.white}} .hd.crim{color:${C.red}}
    .k{font-family:${FONT_UI};font-size:22px;color:${C.dim};letter-spacing:.12em;text-transform:uppercase;
       align-self:center}
    .a,.b{font-family:${FONT_UI};font-size:26px;font-weight:500;line-height:1.4;align-self:center}
    .b{color:${C.red}dd}`);
}

/**
 * Cities are plotted from real coordinates on a simple equirectangular
 * projection, so their positions relative to each other are geographically
 * correct. The peninsula behind them is an intentionally simplified silhouette,
 * labelled as stylised rather than presented as a survey map.
 */
function italyMap() {
  const cities = [
    ['Turin', 45.07, 7.69], ['Milan', 45.46, 9.19], ['Florence', 43.77, 11.26],
    ['Rome', 41.90, 12.50], ['Reggio Calabria', 38.11, 15.65]
  ];
  const minLon = 6.0, maxLon = 18.6, minLat = 36.5, maxLat = 47.2;
  const X = lon => 300 + ((lon - minLon) / (maxLon - minLon)) * 1000;
  const Y = lat => 70 + ((maxLat - lat) / (maxLat - minLat)) * 830;

  const pins = cities.map(([n, lat, lon], i) => `
    <circle cx="${X(lon).toFixed(0)}" cy="${Y(lat).toFixed(0)}" r="10" fill="${C.red}"/>
    <circle class="ring r${i % 3}" cx="${X(lon).toFixed(0)}" cy="${Y(lat).toFixed(0)}" r="10"
            fill="none" stroke="${C.red}" stroke-width="2"/>
    <text x="${(X(lon) + 36).toFixed(0)}" y="${(Y(lat) + 9).toFixed(0)}"
          fill="${C.white}" font-family="${FONT_UI}" font-size="28" letter-spacing="2">${n.toUpperCase()}</text>`).join('');

  return page(`
    <div class="kicker">Clubs sanctioned</div>
    <svg viewBox="0 0 1500 950" width="1420" height="820">
      <path d="M430 190 L520 158 L600 196 L680 182 L760 230 L820 300 L858 380
               L898 450 L958 520 L1006 580 L1036 640 L1076 700 L1116 770
               L1166 828 L1136 868 L1076 838 L1016 778 L966 718 L916 668
               L856 618 L796 568 L736 508 L676 448 L616 398 L556 348
               L496 298 L448 248 Z"
            fill="${C.navy}" stroke="${C.white}33" stroke-width="3"/>
      ${pins}
    </svg>
    <div class="note">Stylised map &mdash; city positions from real coordinates</div>`, `
    .ring{transform-origin:center;transform-box:fill-box;animation:ringPulse 2.6s ease-out infinite}
    .ring.r1{animation-delay:.6s} .ring.r2{animation-delay:1.2s}
    @keyframes ringPulse{0%{transform:scale(1);opacity:.75}100%{transform:scale(3.2);opacity:0}}`);
}

function timeline() {
  const beats = [
    ['2006', 'Recordings published'],
    ['2006', 'Sporting sanctions'],
    ['2006&ndash;2015', 'Criminal proceedings'],
    ['Mar 2015', 'Charges time-barred']
  ];
  const items = beats.map(([y, l], i) => `
    <div class="beat enter d${i + 1}">
      <div class="dot ${i === 3 ? 'end' : ''}"></div>
      <div class="yr">${y}</div><div class="lb">${l}</div>
    </div>`).join('');
  return page(`
    <div class="kicker enter d0">Timeline</div>
    <div class="track"><div class="fill"></div></div>
    <div class="beats">${items}</div>`, `
    .track{position:relative;width:1440px;height:8px;margin-bottom:-14px;border-radius:5px;overflow:hidden;
           background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.14)}
    .fill{position:absolute;inset:0;width:0;background:linear-gradient(90deg,${C.redDeep},${C.red});
          box-shadow:0 0 20px ${C.red}aa;animation:draw 1.6s cubic-bezier(.16,1,.3,1) .3s forwards}
    @keyframes draw{to{width:100%}}
    .beats{display:flex;justify-content:space-between;width:1440px;margin-top:34px}
    .beat{display:flex;flex-direction:column;align-items:center;width:330px}
    .dot{width:22px;height:22px;border-radius:50%;background:${C.bg};
         border:4px solid ${C.white}55;margin-bottom:28px;box-shadow:0 0 0 6px rgba(255,255,255,.04)}
    .dot.end{border-color:${C.red};background:${C.red};box-shadow:0 0 24px ${C.red}}
    .yr{font-family:${FONT_DISPLAY};font-size:36px;color:${C.red};letter-spacing:.03em;margin-bottom:10px}
    .lb{font-family:${FONT_UI};font-size:22px;font-weight:600;color:${C.white}cc;text-align:center;
        letter-spacing:.04em;text-transform:uppercase;line-height:1.35}`);
}

function trophyPlinth() {
  return page(`
    <div class="kicker enter d0">Titles stripped</div>
    <div class="plinths">
      <div class="p enter d1"><div class="slot glass"><span>2004&ndash;05</span></div><div class="beam"></div><div class="base"></div></div>
      <div class="p enter d2"><div class="slot glass"><span>2005&ndash;06</span></div><div class="beam"></div><div class="base"></div></div>
    </div>
    <div class="note enter d4" style="margin-top:56px">Original graphic &mdash; not official artwork</div>`, `
    .plinths{display:flex;gap:150px}
    .p{position:relative;display:flex;flex-direction:column;align-items:center}
    .slot{position:relative;width:250px;height:250px;border-radius:24px;display:flex;
          align-items:center;justify-content:center;border-color:${C.red}55}
    .slot span{position:relative;z-index:2;font-family:${FONT_DISPLAY};font-size:40px;letter-spacing:.03em;
               color:${C.white}88;text-decoration:line-through;text-decoration-color:${C.red};
               text-decoration-thickness:5px}
    /* Sits outside .slot (not a child) so its glow isn't clipped by the
       glass panel's overflow:hidden; straddles the slot's bottom edge. */
    .p .beam{position:absolute;left:50%;top:215px;width:190px;height:70px;z-index:-1;
             background:radial-gradient(ellipse, ${C.red}70 0%, transparent 72%);
             transform:translateX(-50%) scale(.85);filter:blur(6px);
             animation:beam 3.4s ease-in-out infinite}
    @keyframes beam{0%,100%{opacity:.35;transform:translateX(-50%) scale(.85)}50%{opacity:.85;transform:translateX(-50%) scale(1.18)}}
    .base{width:300px;height:40px;border-radius:10px;margin-top:18px;
          background:linear-gradient(180deg, rgba(255,255,255,.10), rgba(255,255,255,.02));
          border:1px solid rgba(255,255,255,.14)}`);
}

function clock() {
  const ticks = Array.from({ length: 12 }, (_, i) => {
    const a = (i * 30 - 90) * Math.PI / 180;
    return `<line x1="${(250 + 186 * Math.cos(a)).toFixed(1)}" y1="${(250 + 186 * Math.sin(a)).toFixed(1)}"
                  x2="${(250 + 206 * Math.cos(a)).toFixed(1)}" y2="${(250 + 206 * Math.sin(a)).toFixed(1)}"
                  stroke="${C.white}55" stroke-width="5"/>`;
  }).join('');
  return page(`
    <div class="kicker enter d0">Statute of limitations</div>
    <div class="dial glass enter d1">
      <svg viewBox="0 0 500 500" width="430" height="430">
        <circle cx="250" cy="250" r="215" fill="none" stroke="${C.white}2a" stroke-width="6"/>
        ${ticks}
        <line x1="250" y1="250" x2="250" y2="130" stroke="${C.white}" stroke-width="8" stroke-linecap="round"/>
        <g class="hand"><line x1="250" y1="250" x2="345" y2="250" stroke="${C.red}" stroke-width="6" stroke-linecap="round"/></g>
        <circle cx="250" cy="250" r="12" fill="${C.red}"/>
      </svg>
    </div>
    <div class="note enter d3" style="margin-top:44px">Time elapsed, not guilt or innocence</div>`, `
    .dial{padding:40px;border-radius:50%}
    .hand{transform-origin:250px 250px;animation:sweep 6s linear infinite}
    @keyframes sweep{to{transform:rotate(360deg)}}`);
}

// ---------------------------------------------------------------- render

const SHEET = {
  'appointment-system': appointmentSystem,
  'penalty-stages': penaltyStages,
  'sporting-vs-criminal': sportingVsCriminal,
  'italy-map': italyMap,
  'timeline': timeline,
  'trophy-plinth': trophyPlinth,
  'clock': clock,
  'card-footballfiles': () => titleCard('Football Files', 'The stories<br>behind the game'),
  'card-calciopoli': () => titleCard('Italy &middot; 2006', 'Calciopoli'),
  'card-twosystems': () => titleCard('Chapter', 'Two systems'),
  'card-sporting': () => titleCard('Chapter', 'The sporting process'),
  'card-criminal': () => titleCard('Chapter', 'The criminal process'),
  'card-outcome': () => titleCard('Chapter', 'The final legal outcome')
};

const DEFAULT_DUR = 6;
// Rendered clips are capped well below their actual on-screen hold time:
// build-documentary.js already loops a short clip with -stream_loop -1 to
// fill whatever segment duration it needs (the same trick it uses for
// b-roll), so there is no reason to render 29s of unique frames when 8s
// loops cleanly. This is also what keeps each render short enough to finish
// before this environment's background-task time limit.
const MAX_CLIP_S = 8;
const FPS = 12;

/**
 * Every animation on the page is paused the instant content is set, then
 * scrubbed to an exact millisecond before each screenshot. This is what makes
 * the capture deterministic: Chromium's real-time video recorder would give a
 * different frame count on a slow run, this never does.
 */
async function renderClip(browser, name, html, w, h, dur, outPath, work) {
  const p = await browser.newPage();
  await p.setViewportSize({ width: w, height: h });
  await p.setContent(html);
  await p.evaluate(() => document.fonts.ready).catch(() => {});
  await p.evaluate(() => document.getAnimations().forEach(a => { a.pause(); }));

  const frameDir = path.join(work, `frames-${name}`);
  await fs.mkdir(frameDir, { recursive: true });

  const totalFrames = Math.max(1, Math.round(dur * FPS));
  for (let f = 0; f < totalFrames; f++) {
    const t = (f / FPS) * 1000;
    const seed = Math.floor(Math.random() * 1000);
    await p.evaluate(({ t, seed }) => {
      document.getAnimations().forEach(a => { a.currentTime = t; });
      const g = document.getElementById('grainTurb');
      if (g) g.setAttribute('seed', String(seed));
    }, { t, seed });
    await p.screenshot({ path: path.join(frameDir, `f${String(f).padStart(5, '0')}.png`) });
  }
  await p.close();

  await runFFmpeg(['-y', '-framerate', String(FPS), '-i', path.join(frameDir, 'f%05d.png'),
    '-frames:v', String(totalFrames),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', outPath]);

  await fs.rm(frameDir, { recursive: true, force: true });
}

async function shotStill(browser, outPath, html, w, h, settleMs = 1400) {
  const p = await browser.newPage();
  await p.setViewportSize({ width: w, height: h });
  await p.setContent(html);
  await p.evaluate(() => document.fonts.ready).catch(() => {});
  await p.waitForTimeout(settleMs);
  await p.screenshot({ path: outPath });
  await p.close();
}

async function main() {
  const slug = process.argv[2] || 'calciopoli';
  const D = path.join(ROOT, 'data', 'documentaries', slug);
  const outDir = path.join(D, 'graphics');
  const work = path.join(D, 'work-graphics');
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(work, { recursive: true });

  let durations = {};
  try {
    durations = JSON.parse(await fs.readFile(path.join(D, 'segment-durations.json'), 'utf8'));
  } catch {
    console.log('  (no segment-durations.json — run build-documentary.js <slug> --durations first '
      + `for exact hold times; using ${DEFAULT_DUR}s default for every clip)`);
  }
  const durFor = (name) => {
    const hit = Object.entries(durations).find(([g]) => g.endsWith(`/${name}.mp4`));
    return Math.min(hit ? hit[1] : DEFAULT_DUR, MAX_CLIP_S);
  };

  const { chromium } = require('playwright');
  let browser;
  try {
    browser = await chromium.launch();
  } catch (error) {
    browser = await chromium.launch({ channel: 'chrome' });
  }

  // Fast iteration path: one settled-state still, no frame capture. For
  // tuning CSS without paying the full per-clip render cost each time.
  if (process.argv.includes('--preview')) {
    const name = process.argv[process.argv.indexOf('--preview') + 1];
    if (!SHEET[name]) throw new Error(`no such graphic: ${name}`);
    const out = path.join(work, `preview-${name}.png`);
    await shotStill(browser, out, SHEET[name](), 1920, 1080);
    await browser.close();
    console.log(`preview -> ${out}`);
    return;
  }

  // Render exactly one clip and exit. Background tasks in this environment
  // have proven to get killed unpredictably on long runs, so the reliable
  // path is one short-lived foreground process per graphic rather than one
  // long batch job.
  if (process.argv.includes('--only')) {
    const name = process.argv[process.argv.indexOf('--only') + 1];
    if (!SHEET[name]) throw new Error(`no such graphic: ${name}`);
    const dur = durFor(name);
    console.log(`  ${name}.mp4  (${dur}s @ ${FPS}fps)`);
    await renderClip(browser, name, SHEET[name](), 1920, 1080, dur, path.join(outDir, `${name}.mp4`), work);
    await browser.close();
    await fs.rm(work, { recursive: true, force: true });
    return;
  }

  const force = process.argv.includes('--force');
  for (const [name, build] of Object.entries(SHEET)) {
    const dur = durFor(name);
    const outPath = path.join(outDir, `${name}.mp4`);
    if (!force && await fs.access(outPath).then(() => true).catch(() => false)) {
      console.log(`  ${name}.mp4  (already rendered, skipping — pass --force to redo)`);
      continue;
    }
    console.log(`  ${name}.mp4  (${dur}s @ ${FPS}fps)`);
    await renderClip(browser, name, build(), 1920, 1080, dur, outPath, work);
  }

  for (const name of ['penalty-stages', 'sporting-vs-criminal', 'timeline', 'trophy-plinth', 'clock']) {
    await shotStill(browser, path.join(outDir, `${name}-9x16.png`), SHEET[name](), 1080, 1920);
  }
  console.log('  + 5 vertical (9x16) stills');

  await shotStill(browser, path.join(outDir, 'thumbnail.png'), page(`
    <div class="split"><div class="l"></div><div class="r"></div></div>
    <div class="glass ttcard"><div class="tt">Two<br>Verdicts</div></div>`, `
    .split{position:absolute;inset:0;display:flex}
    .l{flex:1;background:radial-gradient(circle at 40% 40%, #2A3550 0%, ${C.bg} 70%)}
    .r{flex:1;background:radial-gradient(circle at 60% 60%, #1A1216 0%, #08080A 70%);
       border-left:6px solid ${C.red}}
    .ttcard{padding:70px 90px}
    .tt{position:relative;font-family:${FONT_DISPLAY};font-size:130px;text-transform:uppercase;
        line-height:.92;letter-spacing:.01em;text-align:center;
        text-shadow:0 8px 40px rgba(0,0,0,.9)}`), 1280, 720);
  console.log('  thumbnail.png');

  await browser.close();
  await fs.rm(work, { recursive: true, force: true });
  console.log(`\nGraphics written to ${outDir}`);
}

main().catch(error => {
  console.error(`build-graphics failed: ${error.message}`);
  process.exit(1);
});
