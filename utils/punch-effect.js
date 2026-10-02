const { runFFmpeg } = require('./ffmpeg');

/**
 * A "punch": the frame snap-zooms in for a fraction of a second and a
 * stinger sound (e.g. a viral meme audio bite) plays under it, mixed with
 * the clip's own dialogue rather than replacing it. This is the actual
 * anatomy of a trending-sound edit — a one-shot hit at the punchline, not a
 * looping backing track — so there is no BPM/beat-grid here to sync to.
 *
 * Deliberately scale+crop, not zoompan: zoompan hangs on this machine once
 * it follows anything with alpha/rgba compositing upstream (see the ffmpeg
 * zoompan deadlock note). A hard if()-gated scale is a plain per-frame
 * expression, not the accumulating zoompan state machine, so it doesn't hit
 * that path — the zoom snaps instantly rather than easing in, which reads as
 * a "hit" anyway and matches how these edits actually cut (0.2-0.4s, on a
 * beat or a word, per how the trend actually looks).
 */
async function applyPunch(inputPath, outputPath, { punchAtSec, stingerPath, zoomFactor = 1.18, punchDurationSec = 0.35 }) {
  const start = punchAtSec.toFixed(3);
  const end = (punchAtSec + punchDurationSec).toFixed(3);

  const vf = `scale=w='if(between(t\\,${start}\\,${end})\\,iw*${zoomFactor}\\,iw)':`
    + `h='if(between(t\\,${start}\\,${end})\\,ih*${zoomFactor}\\,ih)':eval=frame,crop=1080:1920`;

  const delayMs = Math.round(punchAtSec * 1000);
  const filterComplex = `[0:v]${vf}[v];`
    + `[1:a]adelay=${delayMs}|${delayMs}[stinger];`
    + '[0:a][stinger]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]';

  await runFFmpeg([
    '-y', '-i', inputPath, '-i', stingerPath,
    '-filter_complex', filterComplex,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
    outputPath
  ]);
}

module.exports = { applyPunch };
