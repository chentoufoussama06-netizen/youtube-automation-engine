#!/usr/bin/env node
/**
 * Generate video shots with Google Veo (sound included) and join them.
 *
 *   node scripts/ai/veo-shots.js temp/dog-ronaldo-veo.json data/ai-video/dog-ronaldo
 *
 * Input JSON: { "model": "veo-3.1-lite-generate-preview", "aspectRatio": "9:16",
 *               "style": "...", "shots": [{ "id": "s1", "seconds": 8, "prompt": "..." }] }
 * Output: <out>/<id>.mp4 per shot, plus <out>/final.mp4 joined in order.
 *
 * Veo writes the soundtrack itself — crowd, ball, and any line given in quotes
 * as spoken commentary — so there is no separate TTS or SFX pass. That is why
 * this replaced the Lightning route when that account was refused a GPU.
 *
 * Cost is per second of video (Lite ~ $0.03/s at the time of writing), so a
 * shot that already exists is never regenerated.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const API = 'https://generativelanguage.googleapis.com/v1beta';
const KEY = process.env.GEMINI_API_KEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function generate(cfg, shot, dst) {
  const res = await fetch(`${API}/models/${cfg.model}:predictLongRunning?key=${KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [{ prompt: `${shot.prompt} ${cfg.style || ''}`.trim() }],
      parameters: { aspectRatio: cfg.aspectRatio || '9:16', durationSeconds: shot.seconds || 8 }
    })
  });
  const op = await res.json();
  if (!res.ok) throw new Error(`${shot.id}: ${res.status} ${JSON.stringify(op.error || op).slice(0, 300)}`);

  for (let i = 0; i < 90; i++) {
    await sleep(10000);
    const st = await (await fetch(`${API}/${op.name}?key=${KEY}`)).json();
    if (!st.done) continue;
    if (st.error) throw new Error(`${shot.id}: ${JSON.stringify(st.error).slice(0, 300)}`);
    const resp = st.response?.generateVideoResponse || st.response || {};
    const filtered = resp.raiMediaFilteredReasons;
    const uri = resp.generatedSamples?.[0]?.video?.uri || resp.generatedVideos?.[0]?.video?.uri;
    if (!uri) throw new Error(`${shot.id}: no video returned${filtered ? ` (filtered: ${filtered.join('; ')})` : ''}`);
    const vid = await fetch(`${uri}${uri.includes('?') ? '&' : '?'}key=${KEY}`);
    fs.writeFileSync(dst, Buffer.from(await vid.arrayBuffer()));
    return;
  }
  throw new Error(`${shot.id}: timed out after 15 minutes`);
}

async function main() {
  const [cfgPath, outDir] = process.argv.slice(2);
  if (!cfgPath || !outDir) throw new Error('usage: veo-shots.js <shots.json> <out_dir>');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  fs.mkdirSync(outDir, { recursive: true });

  // All shots in parallel: each is a remote job, nothing heavy runs here.
  const results = await Promise.allSettled(cfg.shots.map(async (shot) => {
    const dst = path.join(outDir, `${shot.id}.mp4`);
    if (fs.existsSync(dst)) return console.log(`${shot.id}: already made`);
    console.log(`${shot.id}: generating ${shot.seconds || 8}s...`);
    await generate(cfg, shot, dst);
    console.log(`${shot.id}: done -> ${dst}`);
  }));
  results.filter((r) => r.status === 'rejected').forEach((r) => console.error(`FAILED ${r.reason.message}`));

  const parts = cfg.shots.map((s) => path.join(outDir, `${s.id}.mp4`));
  if (!parts.every((p) => fs.existsSync(p))) throw new Error('not every shot was made - final not joined');

  // Re-encode while joining so shots with slightly different streams still line up.
  const inputs = parts.flatMap((p) => ['-i', p]);
  const filter = parts.map((_, i) => `[${i}:v][${i}:a]`).join('') + `concat=n=${parts.length}:v=1:a=1[v][a]`;
  const final = path.join(outDir, 'final.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', filter, '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', final]);
  console.log(`final -> ${final}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
