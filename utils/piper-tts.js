// Offline neural TTS via Piper (https://github.com/rhasspy/piper).
//
// WHY THIS EXISTS. The primary narrator is Microsoft Edge TTS, which is free
// and high quality — until it isn't reachable. Edge's websocket endpoint
// intermittently refuses datacenter IPs (the GitHub Actions runners the daily
// autopilot runs on), handing back an HTTP 200 where the upgrade should be and
// failing every retry. When that happens the whole short is lost: no voice, no
// video, nothing posted. Piper runs entirely on the runner's own CPU from a
// downloaded .onnx voice model, so there is no endpoint left to block. It is
// the fallback, never the default: Edge still goes first when it works.
//
// Piper gives no word-boundary metadata, so narration built this way falls
// back to shorts-factory's proportional caption timing — captions still land,
// just estimated from the measured audio length rather than per-word.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runFFmpeg } = require('./ffmpeg');

// Edge neural voice -> Piper voice model (basenames from rhasspy/piper-voices).
// Male English voices map to ryan/alan; female to amy. Anything unmapped uses
// the default so a new Edge voice never silently loses the fallback.
const VOICE_MAP = {
  'en-GB-RyanNeural': 'en_GB-alan-medium',
  'en-US-BrianNeural': 'en_US-ryan-high',
  'en-US-ChristopherNeural': 'en_US-ryan-high',
  'en-US-GuyNeural': 'en_US-ryan-high',
  'en-US-DavisNeural': 'en_US-ryan-high',
  'en-US-AndrewNeural': 'en_US-ryan-high',
  'en-US-JennyNeural': 'en_US-amy-medium',
  'en-US-AriaNeural': 'en_US-amy-medium',
  'en-US-AmberNeural': 'en_US-amy-medium',
};
const DEFAULT_PIPER_VOICE = 'en_US-ryan-high';

function piperBin() {
  return process.env.PIPER_BIN || 'piper';
}

function voicesDir() {
  return process.env.PIPER_VOICES_DIR || path.join(process.cwd(), 'data', 'piper-voices');
}

// A Piper voice is a .onnx model with a companion .onnx.json config beside it;
// both are required. Returns the model path whose config is also present, or
// the default's, or null if neither is installed.
function modelFor(voice) {
  const candidates = [VOICE_MAP[voice], DEFAULT_PIPER_VOICE].filter(Boolean);
  for (const base of candidates) {
    const model = path.join(voicesDir(), `${base}.onnx`);
    if (fs.existsSync(model) && fs.existsSync(`${model}.json`)) return model;
  }
  return null;
}

// True when at least one usable voice model is installed. The binary itself is
// validated at spawn time — a missing binary surfaces as a synth error, which
// the caller already treats as "fallback unavailable, rethrow the Edge error".
function available(voice) {
  try { return Boolean(modelFor(voice)); } catch { return false; }
}

// Synthesise one text chunk to an MP3 buffer matching Edge's output format
// (24 kHz mono, 48 kbit/s) so Piper and Edge chunks are interchangeable and
// concatenate cleanly.
async function synthesizeToMp3(text, voice, logger) {
  const model = modelFor(voice);
  if (!model) throw new Error('no piper voice model installed');

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tmpWav = path.join(os.tmpdir(), `piper-${stamp}.wav`);
  const tmpMp3 = path.join(os.tmpdir(), `piper-${stamp}.mp3`);

  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(piperBin(), ['--model', model, '--output_file', tmpWav], {
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      let err = '';
      proc.stderr.on('data', (d) => { err += String(d); });
      proc.on('error', (e) => reject(new Error(`piper spawn failed: ${e.message}`)));
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`piper exited ${code}: ${err.slice(0, 160)}`));
      });
      proc.stdin.on('error', () => {});   // ignore EPIPE if piper dies early
      proc.stdin.write(text);
      proc.stdin.end();
    });

    if (!fs.existsSync(tmpWav) || fs.statSync(tmpWav).size === 0) {
      throw new Error('piper produced no audio');
    }

    // Match Edge's AUDIO_24KHZ_48KBITRATE_MONO_MP3 so downstream stitching and
    // duration probing behave identically whichever engine spoke.
    await runFFmpeg(['-y', '-i', tmpWav, '-ar', '24000', '-ac', '1', '-b:a', '48k', tmpMp3]);
    const buf = await fs.promises.readFile(tmpMp3);
    if (!buf.length) throw new Error('piper mp3 conversion empty');
    if (logger) logger.info(`Piper narrated ${text.length} chars with ${path.basename(model)}`);
    return buf;
  } finally {
    fs.promises.unlink(tmpWav).catch(() => {});
    fs.promises.unlink(tmpMp3).catch(() => {});
  }
}

module.exports = { synthesizeToMp3, available, VOICE_MAP, DEFAULT_PIPER_VOICE, modelFor, voicesDir };
