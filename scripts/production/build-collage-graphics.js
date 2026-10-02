#!/usr/bin/env node
/**
 * Paper-collage documentary graphics: AI photo background + HTML/CSS text
 * overlay -> Playwright -> PNG.
 *
 * Cloned from a reference video's house style: aged paper, torn-edge photo
 * clippings, red-ink evidence-board annotations, muted sepia tones. The AI
 * image model renders the atmosphere only — no words, no letters. Text
 * generation from these models is unreliable (garbled, misspelled), so every
 * actual label (a year, a name, a caption) is composited afterward as real
 * HTML text on a "torn paper tag," which is also what keeps this on-brand
 * with the channel's fact-checked, legible-first house style.
 *
 * Uses the same generateImage() chain the rest of this repo already uses
 * (OpenAI -> HuggingFace FLUX.1-schnell -> Gemini -> Pollinations) — no new
 * API integration, and per utils/ai-video-generator.js's own comments the
 * HuggingFace account has no payment method attached, so this cannot run up
 * a bill.
 *
 *   node scripts/build-collage-graphics.js calciopoli
 */

require('dotenv').config();

const fs = require('fs').promises;
const path = require('path');
const { AIVideoGenerator } = require('../../utils/ai-video-generator');

const ROOT = path.join(__dirname, '..', '..');

const INK = '#2A1F14';
const PAPER = '#F1E6CE';
const PAPER_DIM = '#E7D9B8';
const RED = '#8C2A22';

const FONT_LINK = `
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Special+Elite&family=Bitter:wght@600;800&display=swap" rel="stylesheet">`;

const FONT_TYPE = "'Special Elite', 'Courier New', monospace";
const FONT_DISPLAY = "'Bitter', Georgia, serif";

const GRAIN = `
<svg class="grain" xmlns="http://www.w3.org/2000/svg">
  <filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3"/></filter>
  <rect width="100%" height="100%" filter="url(#n)"/>
</svg>`;

const BASE = `
  *{margin:0;padding:0;box-sizing:border-box}
  html{height:100%}
  body{width:1920px;height:1080px;position:relative;overflow:hidden;
       font-family:${FONT_TYPE};color:${INK}}
  .bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:saturate(.9) contrast(1.03)}
  .shade{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 45%, transparent 40%, rgba(20,12,6,.55) 100%)}
  .grain{position:absolute;inset:0;opacity:.07;pointer-events:none;mix-blend-mode:multiply}
  .wrap{position:relative;width:100%;height:100%;display:flex;flex-direction:column;
        align-items:center;justify-content:center;padding:90px;z-index:2}

  /* A "torn paper tag": aged card stock, a slight rotation like it was
     dropped onto the board, a taped corner, a hard drop shadow. */
  .tag{position:relative;background:${PAPER};color:${INK};
       box-shadow:0 10px 26px rgba(0,0,0,.55);border:1px solid rgba(0,0,0,.18)}
  .tape{position:absolute;width:70px;height:26px;background:rgba(255,255,235,.55);
        border:1px solid rgba(0,0,0,.08);top:-12px;left:50%;transform:translateX(-50%) rotate(-2deg);
        box-shadow:0 2px 4px rgba(0,0,0,.25)}

  .kicker{font-family:${FONT_TYPE};font-size:26px;letter-spacing:.32em;color:${RED};
          text-transform:uppercase;text-align:center}
  .title{font-family:${FONT_DISPLAY};font-size:96px;font-weight:800;text-align:center;
         line-height:1.02;color:${INK}}
  .note{font-family:${FONT_TYPE};font-size:20px;color:${INK}cc;letter-spacing:.06em;
        text-align:center}
`;

function page(bgFile, inner, extraCss = '') {
  return `<!doctype html><html><head><meta charset="utf-8">${FONT_LINK}<style>${BASE}${extraCss}</style></head>
<body>
  <img class="bg" src="${bgFile}">
  <div class="shade"></div>
  ${GRAIN}
  <div class="wrap">${inner}</div>
</body></html>`;
}

// ---------------------------------------------------------------- prompts

const NO_TEXT = 'no legible text, no words, no letters, no numbers, no writing';
const HOUSE = 'aged vintage paper collage documentary photography, torn deckled paper edges, '
  + 'muted sepia and tan tones, deep red ink annotations, evidence-board investigation aesthetic, '
  + 'soft directional lighting, visible paper grain, mixed media collage, photoreal, ' + NO_TEXT;

const BEATS = {
  'card-footballfiles': {
    prompt: `A worn manila case file lying open on a wooden desk, scattered black-and-white football `
      + `photographs half tucked inside, a vintage magnifying glass resting on top, dim moody lighting, `
      + `${HOUSE}`
  },
  'card-calciopoli': {
    prompt: `An old Italian newspaper front page collage, torn and overlapping layers, a black-and-white `
      + `photo of a packed football stadium crowd, a small torn Italian tricolour ribbon pinned in the `
      + `corner, a red wax seal stamp mark, ${HOUSE}`
  },
  'timeline': {
    prompt: `A row of torn newspaper clipping fragments pinned to a corkboard, connected left to right by `
      + `a taut red string, faded photographs of a football stadium and a courthouse among the clippings, `
      + `${HOUSE}`
  },
  'appointment-system': {
    prompt: `A hand-drawn organisational chart sketched in red ink on aged parchment, faint pencil sketches `
      + `of a referee's whistle and a football pitch in the background, torn paper edges, ${HOUSE}`
  },
  'trophy-plinth': {
    prompt: `Two empty velvet trophy display pedestals in dim museum lighting, a torn photograph of a `
      + `football trophy lying beside them with a red diagonal strike mark across it, ${HOUSE}`
  },
  'penalty-stages': {
    prompt: `A stack of official case documents fanned out on an aged wooden table, red ink stamps and `
      + `paperclips, a gavel resting on top, ${HOUSE}`
  },
  'card-criminal': {
    prompt: `A dim empty courtroom photographed from the back row, wooden benches, a single shaft of light `
      + `on an empty witness stand, aged film grain, ${HOUSE}`
  },
  'sporting-vs-criminal': {
    prompt: `A split composition: on one half a stadium under bright floodlights, on the other a `
      + `courthouse facade under grey overcast sky, a torn line of red thread dividing the two halves, `
      + `${HOUSE}`
  },
  'card-outcome': {
    prompt: `A single old hourglass sitting on a stack of aged legal documents, dim window light, dust `
      + `particles suspended in the air, ${HOUSE}`
  },
  'clock': {
    prompt: `A weathered antique pocket watch photographed close up lying on aged parchment, a faint red `
      + `ink circle drawn around it like an investigator's annotation, dramatic side lighting, ${HOUSE}`
  },
  'thumbnail': {
    prompt: `A torn courtroom document collaged beside a torn stadium photograph, divided by a jagged red `
      + `tear down the middle, dramatic high-contrast lighting, ${HOUSE}`
  }
};

// ---------------------------------------------------------------- overlays

function titleCard(bg, kicker, title) {
  return page(bg, `
    <div class="tag card">
      <div class="tape"></div>
      <div class="kicker">${kicker}</div>
      <div class="title">${title}</div>
    </div>`, `.card{padding:70px 110px;display:flex;flex-direction:column;align-items:center;
      gap:26px;max-width:1500px;transform:rotate(-.6deg)}`);
}

function appointmentSystemOverlay(bg) {
  const nodes = ['FIGC', 'AIA', 'REFEREE\nCOMMISSION', 'DESIGNATORS', 'FIXTURES'];
  const boxes = nodes.map((n, i) => `
    <div class="node tag ${i === 3 ? 'hot' : ''}"><div class="tape"></div>${n.replace(/\n/g, '<br>')}</div>
    ${i < nodes.length - 1 ? '<div class="arrow">&#8594;</div>' : ''}`).join('');
  return page(bg, `
    <div class="kicker tag klabel"><div class="tape"></div>How referees were appointed</div>
    <div class="chain">${boxes}</div>
    <div class="note tag nlabel" style="margin-top:60px">Structure as described in published accounts</div>`, `
    .klabel,.nlabel{padding:14px 26px;transform:rotate(-.8deg)}
    .chain{display:flex;align-items:center;gap:18px;margin-top:50px}
    .node{padding:30px 22px;min-width:180px;text-align:center;font-size:24px;font-weight:700;
          line-height:1.3;transform:rotate(-1deg)}
    .node.hot{background:${PAPER};border:2px solid ${RED};color:${RED}}
    .arrow{font-size:30px;color:${RED}}`);
}

function timelineOverlay(bg) {
  const beats = [
    ['2006', 'Recordings published'],
    ['2006', 'Sporting sanctions'],
    ['2006–2015', 'Criminal proceedings'],
    ['Mar 2015', 'Charges time-barred']
  ];
  const items = beats.map(([y, l], i) => `
    <div class="beat tag" style="transform:rotate(${i % 2 ? '1' : '-1'}deg)"><div class="tape"></div>
      <div class="yr">${y}</div><div class="lb">${l}</div>
    </div>`).join('');
  return page(bg, `
    <div class="kicker tag klabel"><div class="tape"></div>Timeline</div>
    <div class="beats">${items}</div>`, `
    .klabel{padding:14px 26px;margin-bottom:60px;transform:rotate(-.8deg)}
    .beats{display:flex;gap:26px}
    .beat{padding:24px 22px;width:280px;text-align:center}
    .yr{font-family:${FONT_DISPLAY};font-size:32px;font-weight:800;color:${RED};margin-bottom:8px}
    .lb{font-size:20px;line-height:1.35}`);
}

function trophyPlinthOverlay(bg) {
  return page(bg, `
    <div class="kicker tag klabel"><div class="tape"></div>Titles stripped</div>
    <div class="plinths">
      ${['2004–05', '2005–06'].map((y, i) => `
        <div class="slot tag" style="transform:rotate(${i ? '1.2' : '-1.2'}deg)"><div class="tape"></div>
          <span>${y}</span></div>`).join('')}
    </div>
    <div class="note tag nlabel" style="margin-top:50px">Original graphic &mdash; not official artwork</div>`, `
    .klabel,.nlabel{padding:14px 26px;transform:rotate(-.8deg)}
    .plinths{display:flex;gap:120px;margin-top:50px}
    .slot{width:220px;height:220px;display:flex;align-items:center;justify-content:center}
    .slot span{font-family:${FONT_DISPLAY};font-size:38px;font-weight:800;color:${INK}99;
               text-decoration:line-through;text-decoration-color:${RED};text-decoration-thickness:5px}`);
}

function penaltyStagesOverlay(bg) {
  const stages = [['Stage 1', 'First sporting ruling'], ['Stage 2', 'Appeal'], ['Stage 3', 'Later adjustment']];
  const rows = stages.map(([s, l], i) => `
    <div class="row tag" style="transform:rotate(${i % 2 ? '.7' : '-.7'}deg)"><div class="tape"></div>
      <div class="stage">${s}</div><div class="label">${l}</div>
    </div>`).join('');
  return page(bg, `
    <div class="kicker tag klabel"><div class="tape"></div>Points penalties</div>
    ${rows}
    <div class="unver">Figures unverified</div>`, `
    .klabel{padding:14px 26px;margin-bottom:44px;transform:rotate(-.8deg)}
    .row{display:flex;align-items:center;gap:26px;width:1100px;padding:24px 32px;margin-bottom:16px}
    .stage{font-family:${FONT_DISPLAY};font-size:26px;font-weight:800;color:${RED};width:140px}
    .label{font-size:24px;flex:1}
    .unver{margin-top:30px;font-size:22px;letter-spacing:.2em;color:${RED};text-transform:uppercase;
           background:${PAPER};padding:12px 24px;transform:rotate(-1deg)}`);
}

function sportingVsCriminalOverlay(bg) {
  const rows = [
    ['Purpose', "Enforce the sport's own rules", 'Determine criminal liability'],
    ['Procedure', 'Federation tribunals', 'Courts, with appeals'],
    ['Timing', 'Concluded in weeks', 'Ran for years'],
    ['Outcome here', 'Sanctions imposed', 'A more complicated legal outcome']
  ].map(([k, a, b]) => `<div class="k">${k}</div><div class="a">${a}</div><div class="b">${b}</div>`).join('');
  return page(bg, `
    <div class="kicker tag klabel"><div class="tape"></div>Two separate processes</div>
    <div class="grid tag">
      <div class="hd"></div><div class="hd sport">Sporting</div><div class="hd crim">Criminal</div>
      ${rows}
    </div>
    <div class="note tag nlabel" style="margin-top:40px">Neither process is an appeal against the other</div>`, `
    .klabel,.nlabel{padding:14px 26px;transform:rotate(-.8deg)}
    .grid{display:grid;grid-template-columns:210px 1fr 1fr;gap:18px 30px;width:1320px;
          padding:44px 50px;margin-top:40px;transform:rotate(.4deg)}
    .hd{font-size:22px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;
        padding-bottom:14px;border-bottom:2px solid ${INK}33}
    .hd.crim{color:${RED}}
    .k{font-size:19px;color:${INK}99;letter-spacing:.06em;text-transform:uppercase;align-self:center}
    .a,.b{font-size:23px;line-height:1.4;align-self:center}
    .b{color:${RED}}`);
}

function clockOverlay(bg) {
  return page(bg, `
    <div class="kicker tag klabel"><div class="tape"></div>Statute of limitations</div>
    <div class="note tag nlabel" style="margin-top:640px">Time elapsed, not guilt or innocence</div>`, `
    .klabel,.nlabel{padding:14px 26px;transform:rotate(-.8deg)}`);
}

const OVERLAY_BUILDERS = {
  'card-footballfiles': bg => titleCard(bg, 'Football Files', 'The stories<br>behind the game'),
  'card-calciopoli': bg => titleCard(bg, 'Italy · 2006', 'Calciopoli'),
  'card-criminal': bg => titleCard(bg, 'Chapter', 'The criminal<br>process'),
  'card-outcome': bg => titleCard(bg, 'Chapter', 'The final<br>legal outcome'),
  'appointment-system': appointmentSystemOverlay,
  'timeline': timelineOverlay,
  'trophy-plinth': trophyPlinthOverlay,
  'penalty-stages': penaltyStagesOverlay,
  'sporting-vs-criminal': sportingVsCriminalOverlay,
  'clock': clockOverlay,
  'thumbnail': bg => page(bg, `
    <div class="tag ttcard"><div class="tape"></div><div class="title" style="font-size:120px">Two<br>Verdicts</div></div>`,
    `.ttcard{padding:60px 90px;transform:rotate(-1deg)}`)
};

async function main() {
  const slug = process.argv[2] || 'calciopoli';
  const D = path.join(ROOT, 'data', 'documentaries', slug);
  const outDir = path.join(D, 'graphics');
  const bgDir = path.join(D, 'collage-backgrounds');
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(bgDir, { recursive: true });

  const generator = new AIVideoGenerator({});
  const force = process.argv.includes('--force');

  const { chromium } = require('playwright');
  let browser;
  try {
    browser = await chromium.launch();
  } catch (error) {
    browser = await chromium.launch({ channel: 'chrome' });
  }

  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;

  for (const [name, { prompt }] of Object.entries(BEATS)) {
    if (only && name !== only) continue;
    const bgPath = path.join(bgDir, `${name}.png`);
    const outName = name === 'thumbnail' ? 'thumbnail.png' : `${name}.png`;
    const outPath = path.join(outDir, outName);

    if (!force && await fs.access(outPath).then(() => true).catch(() => false)) {
      console.log(`  ${outName}  (already rendered, skipping — pass --force to redo)`);
      continue;
    }

    if (force || !(await fs.access(bgPath).then(() => true).catch(() => false))) {
      console.log(`  generating background: ${name}...`);
      await generator.generateImage(prompt, bgPath);
    }

    const build = OVERLAY_BUILDERS[name];
    const html = build(await pngDataUrl(bgPath));
    const p = await browser.newPage();
    await p.setViewportSize({ width: 1920, height: 1080 });
    await p.setContent(html);
    await p.evaluate(() => document.fonts.ready).catch(() => {});
    await p.waitForTimeout(150);
    await p.screenshot({ path: outPath });
    await p.close();
    console.log(`  ${outName}  composited`);
  }

  await browser.close();
  console.log(`\nGraphics written to ${outDir}`);
}

// page.setContent() gives the page an opaque origin, which blocks file://
// resource loads — a data URI sidesteps that entirely.
async function pngDataUrl(p) {
  const buf = await fs.readFile(p);
  return 'data:image/png;base64,' + buf.toString('base64');
}

main().catch(error => {
  console.error(`build-collage-graphics failed: ${error.message}`);
  process.exit(1);
});
