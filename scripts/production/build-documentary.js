#!/usr/bin/env node
/**
 * Assemble the documentary from original graphics.
 *
 *   node scripts/build-documentary.js calciopoli
 *
 * Everything on screen in the 16:9 film is a PNG this repo rendered itself, so
 * there is no licence check and nothing that could be mistaken for archive.
 *
 * Segment durations come from the narration's real word timings rather than a
 * guessed clock, so a graphic changes when the subject changes.
 */

const fs = require('fs').promises;
const path = require('path');
const { runFFmpeg } = require('../../utils/ffmpeg');

const ROOT = path.join(__dirname, '..', '..');

// Graphic order, each cued to a phrase in the narration. Because the cue is
// matched against the word-timing stream, re-recording the read re-cuts the
// picture automatically.
// Real photographs of the actual venues and moving b-roll carry the film;
// graphics appear only where they carry information footage cannot — the
// appointment chain, the two-standards comparison, the redacted figures.
// A documentary made entirely of diagrams is accurate and unwatchable.
//
// Cues match the SPOKEN word stream, so avoid digits and contractions: Edge TTS
// renders "2006" as "two thousand and six" and "wasn't" arrives as one token.
// Both mismatches silently dropped a graphic from an earlier build.
const SEQUENCE = [
  ['graphics/card-footballfiles.png', null],
  ['graphics/card-calciopoli.png', 'reigning champions'],
  ['assets/juve-stadium-1.jpg', 'relegated to Serie B'],
  ['assets/broll-1.mp4', 'It started with transcripts'],
  ['graphics/timeline.png', 'Early May'],
  ['assets/broll-3.mp4', 'The recordings'],
  ['graphics/appointment-system.png', 'To get why this mattered'],
  ['assets/broll-2.mp4', 'The allegation concerned'],
  ['assets/juve-stadium-2.jpg', 'Italian football did not wait'],
  ['graphics/trophy-plinth.png', 'stripped of two league titles'],
  ['graphics/penalty-stages.png', 'Points penalties came down'],
  ['assets/san-siro-1.jpeg', 'only Juventus'],
  ['assets/olimpico-1.jpg', 'compressed down to five words'],
  ['graphics/card-criminal.png', 'Then the criminal case started'],
  ['graphics/sporting-vs-criminal.png', 'Sporting justice and criminal'],
  ['graphics/card-outcome.png', 'The central charge'],
  ['graphics/clock.png', 'The case ran for nearly'],
  ['assets/broll-4.mp4', 'Read that carefully'],
  ['assets/san-siro-2.jpg', 'Football answered this']
];

/** When is this phrase spoken? Derived from real word boundaries. */
function cueTime(words, phrase) {
  if (!phrase) return 0;
  const target = phrase.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  const flat = words.map(w => w.word.toLowerCase().replace(/[^a-z0-9]/g, ''));
  for (let i = 0; i <= flat.length - target.length; i++) {
    if (target.every((t, j) => flat[i + j] === t)) return words[i].start;
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const slug = args.find(a => !a.startsWith('--')) || 'calciopoli';
  const D = path.join(ROOT, 'data', 'documentaries', slug);
  const G = path.join(D, 'graphics');
  const work = path.join(D, 'work');
  await fs.mkdir(work, { recursive: true });

  const words = JSON.parse(await fs.readFile(path.join(D, 'word-timings.json'), 'utf8'));
  const total = words[words.length - 1].end;

  const cues = [];
  for (const [graphic, phrase] of SEQUENCE) {
    const t = cueTime(words, phrase);
    if (phrase && t === null) {
      console.log(`  (cue not found, skipped: "${phrase}")`);
      continue;
    }
    cues.push({ graphic, start: phrase ? t : 0 });
  }
  cues.sort((a, b) => a.start - b.start);

  const segments = cues.map((c, i) => ({
    graphic: c.graphic,
    dur: Math.max(2.5, (i === cues.length - 1 ? total + 2.5 : cues[i + 1].start) - c.start)
  }));

  console.log(`Narration ${total.toFixed(1)}s -> ${segments.length} segments`);

  if (args.includes('--durations')) {
    const map = {};
    for (const s of segments) map[s.graphic] = Number(s.dur.toFixed(2));
    const out = path.join(D, 'segment-durations.json');
    await fs.writeFile(out, JSON.stringify(map, null, 2));
    console.log(`Wrote ${out} (no video assembled)`);
    for (const [g, d] of Object.entries(map)) console.log(`  ${g}  ${d}s`);
    return;
  }

  const parts = [];
  for (let i = 0; i < segments.length; i++) {
    const { graphic, dur } = segments[i];
    const out = path.join(work, `seg${String(i).padStart(2, '0')}.mp4`);
    const frames = Math.round(dur * 30);
    const z = i % 2 === 0 ? '1.0008' : '1.0005';

    const src = path.join(D, graphic);
    const isVideo = /\.(mp4|mov|mkv|webm)$/i.test(graphic);
    const fades = `fade=t=in:d=0.5,fade=t=out:st=${(dur - 0.5).toFixed(2)}:d=0.5`;

    if (isVideo) {
      // B-roll already moves, so it only needs framing. -stream_loop covers a
      // clip shorter than its slot rather than freezing on the last frame.
      await runFFmpeg(['-y', '-stream_loop', '-1', '-t', dur.toFixed(2), '-i', src,
        '-vf', 'scale=1920:1080:force_original_aspect_ratio=increase:flags=lanczos,'
          + `crop=1920:1080,fps=30,${fades}`,
        '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-pix_fmt', 'yuv420p', out]);
    } else {
      // Motion on a still comes from an animated crop over a slightly oversized
      // frame, not zoompan. zoompan re-derives its scale every frame and took
      // eight MINUTES per segment here; this is one pass and runs in seconds.
      const drift = i % 2 === 0 ? 1 : -1;
      await runFFmpeg(['-y', '-loop', '1', '-t', dur.toFixed(2), '-i', src,
        '-vf', 'scale=2112:-2,crop=2112:1188,'
          + `crop=1920:1080:x='(iw-ow)/2+sin(t/7)*${28 * drift}':y='(ih-oh)/2+cos(t/11)*14',`
          + `fps=30,${fades}`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', out]);
    }
    parts.push(out);
    process.stdout.write(`\r  segment ${i + 1}/${segments.length}   `);
  }
  console.log('');

  const listFile = path.join(work, 'concat.txt');
  await fs.writeFile(listFile, parts.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n'));

  const silent = path.join(work, 'silent.mp4');
  await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', silent]);

  const ass = path.relative(process.cwd(), path.join(D, 'subtitles.ass')).replace(/\\/g, '/');
  const finalOut = path.join(D, `documentary-${slug}.mp4`);
  await runFFmpeg(['-y', '-i', silent, '-i', path.join(D, 'narration.mp3'),
    '-filter_complex', `[0:v]subtitles='${ass}'[v]`,
    '-map', '[v]', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-shortest', finalOut]);

  console.log(`\ndocumentary-${slug}.mp4  ${((await fs.stat(finalOut)).size / 1048576).toFixed(0)} MB`);

  await fs.copyFile(path.join(G, 'thumbnail.png'), path.join(D, `thumbnail-${slug}.png`));
  console.log(`thumbnail-${slug}.png`);
}

main().catch(error => {
  console.error(`build-documentary failed: ${error.message}`);
  process.exit(1);
});
