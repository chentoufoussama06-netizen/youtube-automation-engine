const fs = require('fs');
const OpenAI = require('openai');

/**
 * Real speech-to-text on an audio file via Groq's hosted Whisper endpoint —
 * shared by make-clip.js (one clip) and find-clips.js (many chunks of a full
 * VOD), so both get identical caption quality from one place.
 *
 * Returns null if there's no GROQ_API_KEY configured, so callers can fall
 * back to shipping without burned captions instead of crashing.
 */
async function transcribeAudioFile(audioPath, { logger } = {}) {
  if (!process.env.GROQ_API_KEY) {
    if (logger) logger.warn('No GROQ_API_KEY — skipping transcription.');
    return null;
  }
  const client = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1' });
  const resp = await client.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: 'whisper-large-v3',
    response_format: 'verbose_json',
    timestamp_granularities: ['word']
  });

  if (Array.isArray(resp.words) && resp.words.length) {
    return { text: resp.text || '', words: resp.words.map(w => ({ word: w.word, start: w.start, end: w.end })) };
  }
  // Some responses only carry segment-level timing — split each segment's
  // span evenly across its words rather than losing captions entirely.
  const segments = resp.segments || [];
  const words = [];
  for (const seg of segments) {
    const tokens = String(seg.text || '').trim().split(/\s+/).filter(Boolean);
    const span = (seg.end - seg.start) / (tokens.length || 1);
    tokens.forEach((word, i) => words.push({ word, start: seg.start + i * span, end: seg.start + (i + 1) * span }));
  }
  return { text: resp.text || '', words };
}

module.exports = { transcribeAudioFile };
