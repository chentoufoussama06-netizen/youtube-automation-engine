/* global fetch, AbortSignal, clearTimeout */
// Shorts factory — turn a finished long-form episode into vertical shorts.
//
// The format being copied is the split-screen one that performs in the feed:
// story on top, continuous motion underneath, big burned captions. It works on
// retention mechanics, not on whose clip is in it — the motion stops the eye
// leaving, the captions carry the story with sound off, and the first second
// has to land a hook. All of that is reproducible with our own narration, which
// is the version that can actually be monetised: material you did not create
// and did not transform gets claimed by Content ID and fails YPP review.
//
// Captions are word-timed, not guessed. Edge TTS can return word boundary
// metadata, so each word gets a real start and end rather than the character
// count estimate most auto-captioning falls back to.
const fs = require('fs').promises;
const path = require('path');
const { Logger } = require('./logger');

// Bottom-half filler, used only when no local capture is available.
//
// These are driving and motion shots rather than the abstract loops that were
// here first (kinetic sand, flowing paint). The format's bottom panel works
// because forward motion through a space reads as "something is happening" at
// the edge of attention — a satisfying-loop aesthetic is a different genre and
// pulls against a documentary about a killing.
//
// Every entry is a Pexels stock query, so nothing here carries anyone else's
// copyright. A local capture in data/gameplay/ beats all of them and is what
// the pipeline reaches for first.
const MOTION_QUERIES = [
  'driving pov highway', 'motorcycle pov road', 'car dashboard night driving',
  'aerial highway at night', 'first person walking city street',
  'drone following car', 'train window moving landscape', 'neon tunnel driving'
];

class ShortsFactory {
  constructor(options = {}) {
    this.logger = options.logger || new Logger('ShortsFactory');
    this.credentials = options.credentials || {};
  }

  /**
   * Compress a full episode into one 40-50 second vertical script.
   *
   * A short is not a trailer for the documentary, it is a complete small story:
   * hook, escalation, payoff. The single most important line is the first —
   * roughly one second to stop a thumb — which is why it is requested
   * separately rather than left to the model's sense of structure.
   */
  async writeShortScript(script, opts = {}) {
    const { AITextService } = require('./ai-text-service');
    const service = new AITextService(this.credentials);
    if (!service.isAvailable()) throw new Error('no AI text provider available');

    const sections = (script.mainContent?.sections || [])
      .map((s, i) => `${i + 1}. ${s.title}: ${String(s.content || '').replace(/\s+/g, ' ').slice(0, 180)}`)
      .join('\n');

    const prompt = `You are cutting ONE vertical short (40-50 seconds spoken) out of this documentary.

Title: ${script.title}
Sections:
${sections}

Return only valid JSON, matching this exact shape (values illustrative, not
to be reused):
{"hook":"Ten days after scoring an own goal, he was murdered.","body":["He had defied his own country's odds to reach the tournament.","Then his shot found the wrong net.","Colombia was eliminated. He flew home anyway.","A week later, three men were waiting outside a bar."],"payoff":"His murderers reportedly shouted the scoreline as they fired."}

Rules:
- "hook" is the FIRST line and decides whether anyone watches. HARD RULES:
  * MAXIMUM 12 WORDS. Count them. The best performing hooks are 10.
  * ONE concrete shocking fact, present tense. Nothing else.
  * NO qualifying or explaining clauses. Never "with...", never "after years
    of...", never "before and during...". A qualifier kills the tension.
  * NEVER give away the resolution. The hook must leave a question that the rest
    of the video answers; a hook that summarises the story gives nobody a reason
    to keep watching.
  Good (10 words): "Ten days after scoring an own goal, he was murdered."
  Good (10 words): "71 people perish when their plane runs out of fuel."
  Bad (21 words, explains and qualifies): "Twenty-three people died in the Munich
    air disaster, with 20 killed at the scene and three more succumbing later."
  Bad (14 words, reads as an obituary): "Garrincha, one of Brazil's greatest
    footballers, died in 1983 after years of financial struggle."
  Bad (no fact at all): "Today we look at the story of a Colombian footballer."
- "body" is 4-7 short spoken sentences that escalate. One idea per sentence.
- "payoff" is the last line — the fact that makes someone comment or replay it.
- NEVER use the words "kill", "kills", "killed", "die", "dies", "died", "harm",
  or "suicide"/"suicidal", anywhere, even about someone else's death in the
  same story. Say what happened instead: "lost their lives", "collapsed",
  "were crushed", "never woke up", "gave way beneath them". This is a fixed
  house style rule, not optional per topic.
- Total across hook + body + payoff must be 110-140 words. This is a hard limit;
  at normal narration speed that is 40-50 seconds.
- Plain spoken English. No section labels, no "firstly", no rhetorical questions.
- Everything must be factually supported by the sections above. Invent nothing.`;

    const raw = await service.generateText(prompt, { maxTokens: 900, temperature: 0.85, json: true });
    const text = String(raw).replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text);

    const lines = [parsed.hook, ...(parsed.body || []), parsed.payoff]
      .map(l => String(l || '').trim())
      .filter(Boolean);

    if (lines.length < 3) throw new Error('short script came back too thin');

    const fullText = lines.join(' ');
    const wordCount = fullText.split(/\s+/).length;
    this.logger.info(`Short script: ${wordCount} words, hook = "${lines[0].slice(0, 60)}"`);

    if (wordCount > (opts.maxWords || 170)) {
      this.logger.warn(`Short script is ${wordCount} words — longer than the 40-50s target`);
    }
    return { hook: lines[0], lines, fullText, wordCount };
  }

  /**
   * Check the short's factual claims before it is ever narrated.
   *
   * The first short produced called Andres Escobar "Colombia's captain" — he
   * was a centre-back; Valderrama wore the armband. That class of error is what
   * this catches: the compression step rewrites sentences and quietly promotes
   * people, rounds numbers, and merges dates, and none of it is visible in a
   * copy that reads fluently.
   *
   * Checking against the source script alone is not enough, because the source
   * can carry the same error. So the model is asked to judge each claim on what
   * it actually knows, using the source only as context, and to say plainly
   * when it is not confident rather than defending the sentence.
   *
   * Returns { issues, corrected, changed }.
   */
  async factCheckShort(shortText, script) {
    const { AITextService } = require('./ai-text-service');
    const service = new AITextService(this.credentials);
    if (!service.isAvailable()) {
      this.logger.warn('No text provider for fact-checking — copy goes out unverified');
      return { issues: [], corrected: shortText, changed: false };
    }

    const source = (script.mainContent?.sections || [])
      .map(s => `${s.title}: ${String(s.content || '').replace(/\s+/g, ' ').slice(0, 240)}`)
      .join('\n');

    const prompt = `Fact-check this short video script about a real event. Be strict.

SCRIPT TO CHECK:
${shortText}

SOURCE MATERIAL (context only — it may itself contain errors):
${source}

Return only valid JSON:
{ "issues": [ { "claim": "...", "problem": "...", "correction": "..." } ],
  "corrected": "..." }

Check every one of these, they are where this goes wrong:
- ROLES AND TITLES: captain, manager, president, record holder. Do not accept a
  title just because the script states it.
- NUMBERS: shots fired, people killed, attendance, transfer fees, ages, shirt
  numbers.
- DATES AND ORDER: exact days, and whether events really happened in the order
  implied.
- ATTRIBUTION: who did or said a thing, and whether a motive is established fact
  or merely widely assumed.

Rules:
- List an issue ONLY where the script is wrong or unsupported. An accurate script
  returns an empty issues array.
- "corrected" must be the full script with every issue fixed, keeping the
  original length, tone and — above all — the impact of the opening line.
- If a claim cannot be verified, remove it or soften it to what is certain.
  Never replace one invented specific with another.
- Change nothing that is already correct.`;

    try {
      const raw = await service.generateText(prompt, { maxTokens: 1400, temperature: 0.2, json: true });
      const text = String(raw).replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text);

      const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
      const corrected = String(parsed.corrected || '').trim() || shortText;

      // A "correction" that guts the script is a failure of the checker, not a
      // very wrong script — keep the original and surface the issues instead.
      const ratio = corrected.split(/\s+/).length / Math.max(1, shortText.split(/\s+/).length);
      if (ratio < 0.6 || ratio > 1.6) {
        this.logger.warn(`Fact-check rewrite changed length by ${Math.round((ratio - 1) * 100)}% — keeping the original copy`);
        return { issues, corrected: shortText, changed: false };
      }

      if (issues.length) {
        this.logger.warn(`Fact-check found ${issues.length} issue(s):`);
        for (const issue of issues) {
          this.logger.warn(`  - "${String(issue.claim).slice(0, 70)}" — ${String(issue.problem).slice(0, 90)}`);
        }
      } else {
        this.logger.info('Fact-check: no issues found');
      }

      return { issues, corrected, changed: corrected !== shortText };
    } catch (error) {
      // Never block a render on the checker itself failing, but never let that
      // silently pass as "verified" either.
      this.logger.warn(`Fact-check failed (${String(error.message).slice(0, 70)}) — copy is UNVERIFIED`);
      return { issues: [], corrected: shortText, changed: false, failed: true };
    }
  }

  /**
   * Narrate, capturing per-word timings where the service provides them.
   * Returns { audioPath, words: [{ word, start, end }], timed } in seconds.
   */
  async narrateWithTiming(text, voice, audioPath) {
    const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
    const FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;

    // CHUNKED, BOUNDED AND RETRIED — this used to be one unguarded toStream()
    // over the whole text, and Edge's websocket drops long or unlucky requests
    // part-way through ("Stream closed before the synthesis completed, no
    // turn.end received"). On one r/soccer batch that killed six stories out of
    // eight: a single transient socket drop threw away a whole narration.
    // ai-video-generator.js already solved this; narrateWithTiming never got
    // the same treatment because it also has to collect word boundaries.
    const ttsTimeoutMs = Number(process.env.EDGE_TTS_TIMEOUT_MS) || 90000;
    const withTimeout = (promise, label) => {
      let timer;
      return Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out after ${ttsTimeoutMs / 1000}s`)), ttsTimeoutMs);
        })
      ]).finally(() => clearTimeout(timer));
    };

    // Characters Edge will not speak.
    //
    // A single "✔️" made one story fail all three retries with the same
    // "no turn.end received" the transient drops produce — so an unspeakable
    // character is indistinguishable from a dead socket unless it is removed
    // first. Broken entities come in from scrapers too: Apify's Reddit actor
    // returns "&39;" rather than "&#39;", which survives normal unescaping and
    // reaches the synthesiser as literal ampersand-three-nine.
    const speakable = (src) => String(src)
      .replace(/&#?(\d{2,4});?/g, (m, code) => String.fromCharCode(Number(code)))
      // FE00-FE0F are variation selectors, deliberately stripped so no stray
      // emoji modifier survives to the synthesiser; the rule's complaint does
      // not apply to a strip-everything class.
      // eslint-disable-next-line no-misleading-character-class
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{2B00}-\u{2BFF}]/gu, ' ')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    text = speakable(text);
    if (!text) throw new Error('nothing speakable left after sanitising');

    // Split on sentence boundaries — cutting mid-sentence would make the seam
    // between two chunks audible.
    const splitForTts = (src, max = 1200) => {
      const sentences = String(src).match(/[^.!?]+[.!?]+\s*/g) || [String(src)];
      const out = [];
      let current = '';
      for (const s of sentences) {
        if (current && current.length + s.length > max) { out.push(current.trim()); current = ''; }
        current += s;
      }
      if (current.trim()) out.push(current.trim());
      return out.length ? out : [String(src)];
    };

    const parseBoundaries = (buf, into) => {
      // Each event carries ONE complete, pretty-printed JSON document. It must
      // be parsed whole: splitting on newlines first (the obvious approach)
      // hands JSON.parse individual braces and every word is silently lost to
      // the catch, which is exactly how this looked like an unsupported
      // feature rather than a parsing bug.
      let meta;
      try { meta = JSON.parse(String(buf)); } catch (error) { return; }
      for (const item of meta.Metadata || []) {
        const data = item.Data || {};
        // The discriminator lives on the nested text object, not on the item.
        if (data.text?.BoundaryType !== 'WordBoundary') continue;
        // Offsets arrive in 100-nanosecond ticks.
        into.push({
          word: data.text.Text || '',
          start: Number(data.Offset) / 1e7,
          end: (Number(data.Offset) + Number(data.Duration)) / 1e7
        });
      }
    };

    let requested = true;
    const synthesize = async (piece, index, total) => {
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const tts = new MsEdgeTTS();
          // Word boundaries are opt-in. Requesting them must never be fatal —
          // if the service declines, the proportional fallback still yields captions.
          try {
            await tts.setMetadata(voice, FORMAT, { wordBoundaryEnabled: true, sentenceBoundaryEnabled: false });
          } catch (error) {
            requested = false;
            await tts.setMetadata(voice, FORMAT);
          }

          const { audioStream, metadataStream } = await withTimeout(tts.toStream(piece), 'Edge TTS connect');
          const parts = [];
          const bounds = [];
          if (metadataStream) metadataStream.on('data', (buf) => parseBoundaries(buf, bounds));

          const audio = await withTimeout(new Promise((resolve, reject) => {
            audioStream.on('data', (c) => parts.push(c));
            audioStream.on('end', () => resolve(Buffer.concat(parts)));
            audioStream.on('error', reject);
          }), 'Edge TTS stream');

          if (!audio.length) throw new Error('empty audio stream');
          await new Promise((r) => setTimeout(r, 300));   // let metadata drain
          return { audio, bounds };
        } catch (error) {
          lastError = error;
          this.logger.warn(`Edge TTS ${index + 1}/${total} attempt ${attempt}/3: ${String(error.message).slice(0, 70)}`);
          if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
      throw lastError;
    };

    const pieces = splitForTts(text);
    const audioParts = [];
    const boundaries = [];
    let offset = 0;

    for (const [i, piece] of pieces.entries()) {
      const { audio, bounds } = await synthesize(piece, i, pieces.length);
      audioParts.push(audio);
      // Each chunk's offsets restart at zero, so later chunks are shifted by
      // everything already spoken, or their captions would all stack at 0:00.
      for (const b of bounds) boundaries.push({ word: b.word, start: b.start + offset, end: b.end + offset });
      offset += bounds.length ? Math.max(...bounds.map((b) => b.end)) : 0;
    }

    await fs.mkdir(path.dirname(audioPath), { recursive: true });
    await fs.writeFile(audioPath, Buffer.concat(audioParts));
    if (pieces.length > 1) this.logger.info(`Narration stitched from ${pieces.length} TTS chunk(s)`);

    if (boundaries.length) {
      this.logger.info(`Narration timed from ${boundaries.length} word boundaries`);
      return { audioPath, words: this._restorePunctuation(boundaries, text), timed: true };
    }

    // Fallback: spread words across the measured duration by character length,
    // which tracks speaking time far better than word count does.
    const duration = await this.probeDuration(audioPath);
    const tokens = text.split(/\s+/).filter(Boolean);
    const totalChars = tokens.reduce((a, w) => a + w.length + 1, 0) || 1;
    let cursor = 0;
    const words = tokens.map(word => {
      const span = ((word.length + 1) / totalChars) * duration;
      const entry = { word, start: cursor, end: cursor + span };
      cursor += span;
      return entry;
    });
    this.logger.warn(
      `No word boundaries${requested ? '' : ' (not supported)'}; captions estimated from ${duration.toFixed(1)}s audio`
    );
    return { audioPath, words, timed: false };
  }

  /**
   * Edge TTS reports boundary words stripped of punctuation — "goal", never
   * "goal,". Caption chunking breaks on clause endings, so without this the
   * break never fires and cues run straight through commas and full stops
   * ("THIS GOAL HE" / "WAS MURDERED ANDRES"). Walking the source text forward
   * re-attaches whatever punctuation followed each word.
   */
  _restorePunctuation(words, sourceText) {
    let cursor = 0;
    return words.map(entry => {
      if (!entry.word) return entry;
      const at = sourceText.indexOf(entry.word, cursor);
      if (at === -1) return entry;
      cursor = at + entry.word.length;
      const trailing = sourceText.slice(cursor).match(/^["')\]]*[.,!?;:—]+/);
      return trailing ? { ...entry, word: entry.word + trailing[0] } : entry;
    });
  }

  /** Source height, used to decide whether upscale restoration is worth it. */
  async probeHeight(filePath) {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
    try {
      const { stdout } = await promisify(execFile)(ffprobe, [
        '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height',
        '-of', 'default=noprint_wrappers=1:nokey=1', filePath
      ]);
      return Number(String(stdout).trim()) || 0;
    } catch (error) {
      return 0;
    }
  }

  async probeDuration(filePath) {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
    try {
      const { stdout } = await promisify(execFile)(ffprobe, [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', filePath
      ]);
      return Number(String(stdout).trim()) || 0;
    } catch (error) {
      this.logger.warn(`ffprobe failed (${String(error.message).slice(0, 50)}); assuming 45s`);
      return 45;
    }
  }

  /**
   * Word timings -> an ASS subtitle file.
   *
   * Two or three words on screen at a time is the shorts convention, and it is
   * not only style: a full sentence forces reading instead of glancing, and the
   * viewer looks away. Chunks also break at sentence ends so a caption never
   * straddles a full stop.
   */
  buildCaptions(words, opts = {}) {
    const perChunk = opts.wordsPerChunk || 3;
    const fontSize = opts.fontSize || 96;

    const chunks = [];
    let current = [];
    for (const entry of words) {
      current.push(entry);
      // Break on any clause boundary, not just sentence ends. Counting to three
      // alone produced cues like "THIS GOAL, HE" — the comma and the start of
      // the next clause sharing a card, which reads as a stumble.
      const endsClause = /[.!?,;:—]$/.test(entry.word);
      if (endsClause || current.length >= perChunk) {
        chunks.push(current);
        current = [];
      }
    }
    if (current.length) chunks.push(current);

    const toAssTime = (seconds) => {
      const s = Math.max(0, seconds);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      return `${h}:${String(m).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}`;
    };

    const header = [
      '[Script Info]',
      'ScriptType: v4.00+',
      'PlayResX: 1080',
      'PlayResY: 1920',
      'WrapStyle: 2',
      '',
      '[V4+ Styles]',
      'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,'
        + 'Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,'
        + 'Alignment,MarginL,MarginR,MarginV,Encoding',
      // Placement follows the Shorts safe zone: the top ~20% carries the title
      // and channel name, the bottom ~25% the like/comment/share buttons, so
      // captions belong in the centre third.
      //
      // Alignment 5 (screen centre) put text at y=960 — precisely the seam
      // between the two panels, so every caption straddled the boundary between
      // two different images. Alignment 2 anchors to the bottom instead, and
      // MarginV lifts the block to about y=1220: below centre, sitting over the
      // motion panel rather than the story, and clear of the UI controls.
      //
      // Heavy white with a thick black outline is the only combination that
      // stays readable whatever the footage underneath is doing.
      `Style: Pop,Arial Black,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,`
        + `-1,0,0,0,100,100,2,0,1,7,3,2,90,90,${opts.marginV || 700},1`,
      '',
      '[Events]',
      'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text'
    ];

    // Word-by-word highlight (the CapCut/Opus-style pop): the whole chunk stays
    // on screen, but one Dialogue event per word recolors just the word being
    // spoken right now. A static 3-word block reads as a caption; a word
    // lighting up in sync with the voice reads as motion, which is what holds
    // a scroll on a clip channel.
    const highlight = opts.highlightColor || '&H0000D7FF&'; // BGR: vivid orange-gold
    const events = [];
    for (const chunk of chunks) {
      const clean = chunk.map(c => c.word.toUpperCase().replace(/[{}]/g, '').replace(/\r?\n/g, ' '));
      for (let i = 0; i < chunk.length; i++) {
        const start = chunk[i].start;
        const end = i < chunk.length - 1 ? chunk[i + 1].start : chunk[chunk.length - 1].end;
        const line = clean.map((w, idx) => (idx === i ? `{\\c${highlight}}${w}{\\c&HFFFFFF&}` : w)).join(' ');
        events.push(`Dialogue: 0,${toAssTime(start)},${toAssTime(end)},Pop,,0,0,0,,${line}`);
      }
    }

    this.logger.info(`Captions: ${chunks.length} cues (${events.length} word-highlight events) from ${words.length} words`);
    return [...header, ...events].join('\n');
}

  /**
   * FFmpeg's subtitles filter takes a path inside a filter-graph string, where
   * both ":" and "\" are syntax. A raw Windows path (C:\Users\...) is therefore
   * parsed as filter options and fails. Forward slashes plus an escaped drive
   * colon is the form that survives.
   */
  _escapeForFilter(filePath) {
    // Prefer a path relative to the working directory: with no drive letter
    // there is no colon, and nothing needs escaping at all. This is the whole
    // problem avoided rather than worked around.
    const relative = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
    if (relative && !relative.startsWith('..')) {
      return relative;
    }

    // Absolute fallback. FFmpeg needs EXACTLY one backslash before the drive
    // colon — two makes the first escape the second, the colon then reads as an
    // option separator, and the rest of the path is parsed as `original_size`.
    return filePath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');
  }

  /**
   * Compose the vertical short.
   *
   * Layout is two stacked 1080x960 panels: the story on top, continuous motion
   * below. The motion half exists to keep something moving at all times — that
   * is the mechanic this format actually runs on — and the captions sit on the
   * seam between them, where they read against either panel.
   *
   * `layout: 'full'` skips the bottom panel and gives the story the whole
   * 1080x1920 frame, for story-led shorts where borrowed energy is unnecessary.
   */
  /**
   * Footage queries for the short's OWN beats.
   *
   * The first version asked the long-form generator for section queries and
   * took the first N — footage for the opening chapters of a 14-section
   * documentary. But a short compresses the entire arc into 45 seconds, so the
   * pictures tracked the beginning of the story while the narration covered all
   * of it. They could never line up.
   *
   * Splitting the short's own sentences into `count` beats and asking for one
   * shot per beat is what makes the picture change when the sentence does.
   */
  async visualQueriesForShort(shortText, count, script = {}) {
    const { AITextService } = require('./ai-text-service');
    const service = new AITextService(this.credentials);

    const sentences = String(shortText).split(/(?<=[.!?])\s+/).filter(Boolean);
    const perBeat = Math.max(1, Math.ceil(sentences.length / count));
    const beats = [];
    for (let i = 0; i < sentences.length; i += perBeat) {
      beats.push(sentences.slice(i, i + perBeat).join(' '));
    }

    const fallback = () => beats.slice(0, count).map(() => 'empty stadium at dusk');
    if (!service.isAvailable()) return fallback();

    const prompt = `Choose one stock-footage shot for each beat of this short video.

Video title: ${script.title || 'documentary short'}

Beats:
${beats.map((b, i) => `${i + 1}. ${b}`).join('\n')}

First infer WHEN and WHERE this takes place (decade and country) and keep every
shot consistent with it.

Return only valid JSON: { "queries": ["...", "..."] } — exactly ${beats.length},
in order, one per beat.

Rules:
- ENGLISH ONLY, 2-5 words, a PHYSICAL FILMABLE SCENE.
- The shot must depict what THAT beat describes, not the video in general.
- No named people, teams or logos — stock libraries have none and it is a rights risk.
- Sombre and restrained: overcast skies, empty stadiums, rain on glass, dim
  corridors, still floodlights. Never bright, cheerful or advert-looking.`;

    try {
      const raw = await service.generateText(prompt, { maxTokens: 700, temperature: 0.7, json: true });
      const text = String(raw).replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text);
      const queries = (parsed.queries || []).map(q => String(q).trim()).filter(q => q.length > 2);

      if (!queries.length) throw new Error('no queries returned');
      this.logger.info(`Short footage beats: ${queries.slice(0, 3).join(' | ')}${queries.length > 3 ? ' | ...' : ''}`);
      return queries.slice(0, count);
    } catch (error) {
      this.logger.warn(`Short beat queries failed (${String(error.message).slice(0, 60)}); using generic shots`);
      return fallback();
    }
  }

  /**
   * Pick an unused window from a long gameplay capture.
   *
   * One two-hour recording is months of bottom-panel material — 7200 seconds is
   * ~160 clips at 45s each. The only thing that ruins it is the same stretch of
   * road turning up in short after short, so used offsets are remembered per
   * file and re-drawn until one lands far enough from all of them.
   *
   * The source must be footage captured locally. Rockstar's video policy covers
   * your own GTA gameplay; it does not make someone else's upload free to
   * reuse, whatever that upload happens to be titled.
   */
  async pickGameplayWindow(sourcePath, needSeconds, opts = {}) {
    const minGap = opts.minGap || 120;
    const total = await this.probeDuration(sourcePath);
    if (!total || total < needSeconds + 10) {
      throw new Error(`gameplay source is only ${total.toFixed(0)}s — need at least ${(needSeconds + 10).toFixed(0)}s`);
    }

    const ledgerPath = path.join(path.dirname(sourcePath), '.used-offsets.json');
    let ledger = {};
    try {
      ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
    } catch (error) { /* first run — no ledger yet */ }

    const key = path.basename(sourcePath);
    const used = ledger[key] || [];
    // Headroom at both ends: intros and end screens are the two least
    // interesting parts of any capture.
    const lowest = Math.min(30, total * 0.02);
    const highest = total - needSeconds - lowest;

    let offset = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      const candidate = lowest + Math.random() * (highest - lowest);
      if (used.every(u => Math.abs(u - candidate) >= minGap)) {
        offset = candidate;
        break;
      }
    }
    // Every window is now close to one already used — the capture is simply
    // short relative to how many shorts have been cut from it. Recycle the
    // oldest rather than fail a render that is otherwise ready.
    if (offset === null) {
      offset = used.length ? used[0] : lowest;
      this.logger.warn('Gameplay source is running low on unused windows — a longer capture would help');
      used.shift();
    }

    ledger[key] = [...used, Number(offset.toFixed(2))];
    await fs.writeFile(ledgerPath, JSON.stringify(ledger, null, 2));

    this.logger.info(
      `Gameplay window ${offset.toFixed(0)}s-${(offset + needSeconds).toFixed(0)}s `
      + `of ${(total / 60).toFixed(0)}min (${ledger[key].length} used so far)`
    );
    return offset;
  }

  /**
   * A real, rights-cleared still (Wikimedia Commons, CC0/CC-BY) turned into a
   * brief looping clip so it can drop straight into `storyClips` alongside the
   * Pexels-sourced ones — renderShort() treats every entry the same way
   * (`-stream_loop -1 -t segment`), so this is the only adapter needed.
   *
   * Same animated-crop drift build-documentary.js uses for real photos: one
   * ffmpeg pass over a slightly oversized frame, not zoompan (which re-derives
   * its scale every frame and is dramatically slower for the same result).
   */
  async stillToClip(imagePath, seconds, outPath) {
    const { runFFmpeg } = require('./ffmpeg');
    // The photo is fitted whole over a blurred, darkened fill of itself. The
    // old filter was a bare `scale=1188:2112`, which ignores aspect ratio: every
    // landscape photograph — most of Commons — was stretched to roughly three
    // times its height, faces included.
    await runFFmpeg(['-y', '-loop', '1', '-t', seconds.toFixed(2), '-i', imagePath,
      '-filter_complex',
      '[0:v]split[a][b];'
        + '[a]scale=1188:2112:force_original_aspect_ratio=increase,crop=1188:2112,boxblur=24:2,eq=brightness=-0.18[bg];'
        + '[b]scale=1188:1700:force_original_aspect_ratio=decrease[fg];'
        + '[bg][fg]overlay=(W-w)/2:(H-h)/2,'
        + `crop=1080:1920:x='(iw-ow)/2+sin(t/6)*10':y='(ih-oh)/2+cos(t/8)*14',`
        + 'fps=30,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', outPath]);
    return outPath;
  }

  async renderShort({ storyClips, motionClip, audioPath, captionPath, outputPath, layout = 'split', motionStart = 0 }) {
    const { runFFmpeg } = require('./ffmpeg');

    if (!storyClips || !storyClips.length) throw new Error('no story clips to build a short from');

    const duration = await this.probeDuration(audioPath);
    if (!duration) throw new Error('narration audio has no duration');

    const panelHeight = layout === 'split' && motionClip ? 960 : 1920;
    const segment = duration / storyClips.length;
    const args = [];
    const filters = [];

    storyClips.forEach((clip, i) => {
      args.push('-stream_loop', '-1', '-t', segment.toFixed(2), '-i', clip);
      filters.push(
        `[${i}:v]scale=1080:${panelHeight}:force_original_aspect_ratio=increase:flags=lanczos,`
        + `crop=1080:${panelHeight},setsar=1,fps=30,format=yuv420p[s${i}]`
      );
    });
    filters.push(storyClips.map((_, i) => `[s${i}]`).join('') + `concat=n=${storyClips.length}:v=1:a=0[top]`);

    let videoOut = '[top]';
    let nextInput = storyClips.length;

    if (layout === 'split' && motionClip) {
      // -ss before -i seeks the input rather than decoding and discarding, so
      // starting an hour into a two-hour capture costs nothing.
      args.push('-stream_loop', '-1', '-ss', Number(motionStart).toFixed(2),
        '-t', duration.toFixed(2), '-i', motionClip);
      // Upscaling a low-resolution capture magnifies its compression blocking
      // as much as its detail, so a plain scale leaves a 360p source looking
      // worse than it has to. Three steps, and the order is what matters:
      //
      //   hqdn3d  strips the blocking BEFORE it gets magnified. Sharpening
      //           first would lock those artifacts in permanently.
      //   lanczos resolves noticeably more detail than the default bicubic on a
      //           large upscale; it costs a little encode time and nothing else.
      //   unsharp restores the edge definition that any upscale softens.
      //
      // Skipped entirely for sources already at panel height, where denoising
      // and sharpening would only destroy real detail.
      const motionHeight = await this.probeHeight(motionClip);
      const needsRestore = motionHeight > 0 && motionHeight < 900;

      const motionChain = needsRestore
        ? 'hqdn3d=1.5:1.5:6:6,'
          + 'scale=1080:960:force_original_aspect_ratio=increase:flags=lanczos,'
          + 'crop=1080:960,unsharp=5:5:0.8:3:3:0.4,'
        : 'scale=1080:960:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:960,';

      if (needsRestore) {
        this.logger.info(`Motion source is ${motionHeight}p — applying denoise + lanczos + sharpen`);
      }

      filters.push(`[${nextInput}:v]${motionChain}setsar=1,fps=30,format=yuv420p[bot]`);
      filters.push('[top][bot]vstack=inputs=2[stacked]');
      videoOut = '[stacked]';
      nextInput++;
    }

    args.push('-i', audioPath);
    const audioInput = nextInput;

    filters.push(`${videoOut}subtitles='${this._escapeForFilter(captionPath)}'[out]`);

    // The graph is handed over as a file: it grows with clip count, and a long
    // one can overflow the Windows command-line limit.
    const scriptPath = outputPath.replace(/\.mp4$/i, '.filters.txt');
    await fs.writeFile(scriptPath, filters.join(';'));

    args.push(
      '-filter_complex_script', scriptPath,
      '-map', '[out]', '-map', `${audioInput}:a`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
      '-r', '30', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-shortest', outputPath
    );

    this.logger.info(`Rendering ${layout} short: ${storyClips.length} clips over ${duration.toFixed(1)}s`);
    try {
      await runFFmpeg(['-y', ...args]);
    } finally {
      await fs.unlink(scriptPath).catch(() => {});
    }

    this.logger.info(`Short complete: ${path.basename(outputPath)}`);
    return outputPath;
  }
}

module.exports = { ShortsFactory, MOTION_QUERIES };
