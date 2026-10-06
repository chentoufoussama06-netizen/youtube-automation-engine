#!/usr/bin/env node
/**
 * The gate a render must pass before the autopilot is allowed to post it.
 *
 *   node scripts/autopilot/check-video.js <file.mp4> --short
 *   node scripts/autopilot/check-video.js <file.mp4> --long
 *
 * No human watches these before they go out, so this is the only thing
 * standing between a broken render and the channel. It checks what has broken
 * before on this pipeline, not what might in theory: a missing or silent
 * narration track, a picture that is mostly black, a short past the 60s Shorts
 * limit, and a "documentary" that is really a clip because segments dropped.
 */

const { spawnSync } = require('child_process');

const LIMITS = {
  short: { min: 20, max: 60, portrait: true },
  long: { min: 6 * 60, max: 25 * 60, portrait: false }
};

function probe(file) {
  const res = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`ffprobe failed: ${String(res.stderr).trim().slice(0, 200)}`);
  return JSON.parse(res.stdout);
}

/** Seconds of black picture and of silence, from one decode pass. */
function scan(file) {
  const res = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file,
    '-vf', 'blackdetect=d=0.5:pix_th=0.10', '-af', 'silencedetect=n=-45dB:d=2',
    '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const log = String(res.stderr);
  const sum = (re) => [...log.matchAll(re)].reduce((a, m) => a + Number(m[1]), 0);
  return {
    black: sum(/black_duration:([\d.]+)/g),
    silence: sum(/silence_duration: ([\d.]+)/g)
  };
}

function check(file, kind) {
  const lim = LIMITS[kind];
  const problems = [];
  const info = probe(file);
  const duration = Number(info.format?.duration) || 0;
  const video = (info.streams || []).find((s) => s.codec_type === 'video');
  const audio = (info.streams || []).find((s) => s.codec_type === 'audio');

  if (!video) problems.push('no video stream');
  if (!audio) problems.push('no audio stream');
  if (duration < lim.min) problems.push(`too short: ${duration.toFixed(0)}s < ${lim.min}s`);
  if (duration > lim.max) problems.push(`too long: ${duration.toFixed(0)}s > ${lim.max}s`);
  if (video) {
    const portrait = Number(video.height) > Number(video.width);
    if (portrait !== lim.portrait) problems.push(`wrong orientation ${video.width}x${video.height}`);
    if (Math.min(video.width, video.height) < 720) problems.push(`low resolution ${video.width}x${video.height}`);
  }

  if (!problems.length && duration) {
    const { black, silence } = scan(file);
    if (black / duration > 0.1) problems.push(`${((black / duration) * 100).toFixed(0)}% black picture`);
    if (silence / duration > 0.25) problems.push(`${((silence / duration) * 100).toFixed(0)}% silent audio`);
  }

  return { ok: !problems.length, problems, duration };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const kind = args.includes('--long') ? 'long' : 'short';
  const result = check(file, kind);
  console.log(result.ok ? `PASS ${file} (${result.duration.toFixed(0)}s)` : `FAIL ${file}: ${result.problems.join('; ')}`);
  process.exit(result.ok ? 0 : 1);
}

module.exports = { check };
