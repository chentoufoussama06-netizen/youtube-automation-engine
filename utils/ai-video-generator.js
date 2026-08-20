/* global fetch, AbortSignal */
// fetch and AbortSignal are Node globals from v18 onward; package.json already
// pins engines.node to >=18. Declared here because the shared eslint config
// predates them.
const OpenAI = require('openai');
const Replicate = require('replicate');
const fs = require('fs').promises;
const path = require('path');
const { pathToFileURL } = require('url');
const axios = require('axios');
const { Logger } = require('./logger');
const { runFFmpeg, checkFFmpeg, ffmpegInstallHint } = require('./ffmpeg');

class AIVideoGenerator {
  constructor(credentials) {
    this.logger = new Logger('AIVideoGenerator');
    
    // Initialize AI services with graceful fallback
    const openaiKey = credentials.openai?.apiKey || process.env.OPENAI_API_KEY;
    const replicateKey = credentials.replicate?.apiKey || process.env.REPLICATE_API_KEY;
    
    if (openaiKey) {
      this.openai = new OpenAI({ apiKey: openaiKey });
      this.logger.info('OpenAI service initialized');
    } else {
      this.logger.warn('OpenAI API key not found - AI features will be simulated');
    }
    
    if (replicateKey) {
      this.replicate = new Replicate({ auth: replicateKey });
      this.logger.info('Replicate service initialized');
    } else {
      this.logger.warn('Replicate API key not found - advanced video generation unavailable');
    }

    // Gemini media generation (images + native TTS) — free-tier alternative to OpenAI
    const geminiKey = credentials.gemini?.apiKey || process.env.GEMINI_API_KEY;
    if (geminiKey) {
      try {
        const { GoogleGenAI } = require('@google/genai');
        this.gemini = new GoogleGenAI({ apiKey: geminiKey });
        this.logger.info('Gemini media service initialized (images + TTS)');
      } catch (error) {
        this.logger.warn('Failed to initialize Gemini media service:', error.message);
      }
    }
    
    // ElevenLabs configuration
    this.elevenLabsApiKey = credentials.elevenLabs?.apiKey || process.env.ELEVENLABS_API_KEY;
    this.elevenLabsVoiceId = credentials.elevenLabs?.voiceId || process.env.ELEVENLABS_VOICE_ID;
    
    // Azure Speech configuration
    this.azureSpeechKey = credentials.azure?.speechKey || process.env.AZURE_SPEECH_KEY;
    this.azureSpeechRegion = credentials.azure?.speechRegion || process.env.AZURE_SPEECH_REGION;
  }

  async generateTTSAudio(text, outputPath) {
    this.logger.info('Generating TTS audio...');
    
    try {
      // Edge neural voices: no API key, no quota. Gemini's free TTS tier allows
      // 10 requests PER DAY, which cannot sustain even one long video reliably.
      if ((process.env.TTS_PROVIDER || 'edge').toLowerCase() === 'edge') {
        try {
          return await this.generateEdgeTTS(text, outputPath);
        } catch (edgeError) {
          this.logger.warn(`Edge TTS failed (${edgeError.message}); trying other providers`);
        }
      }

      // Try ElevenLabs first (higher quality)
      if (this.elevenLabsApiKey && this.elevenLabsVoiceId) {
        return await this.generateElevenLabsTTS(text, outputPath);
      }
      
      // Fallback to OpenAI TTS
      if (this.openai) {
        return await this.generateOpenAITTS(text, outputPath);
      }

      // Fallback to Gemini native TTS (free tier)
      if (this.gemini) {
        return await this.generateGeminiTTS(text, outputPath);
      }

      // Final fallback to simulation
      return await this.simulateTTSGeneration(text, outputPath);
    } catch (error) {
      this.logger.error('TTS generation failed:', error);
      throw error;
    }
  }

  async generateElevenLabsTTS(text, outputPath) {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.elevenLabsVoiceId}`;
    
    const data = {
      text: text,
      model_id: "eleven_v3",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8,
        style: 0.0,
        use_speaker_boost: true
      }
    };

    const response = await axios({
      method: 'POST',
      url: url,
      data: data,
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': this.elevenLabsApiKey
      },
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        this.logger.info('ElevenLabs TTS generation complete');
        resolve(outputPath);
      });
      writer.on('error', reject);
    });
  }

  async generateOpenAITTS(text, outputPath) {
    const response = await this.openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "coral",
      input: text,
      speed: 1.0
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(outputPath, buffer);

    this.logger.info('OpenAI TTS generation complete');
    return outputPath;
  }

  // Split narration on sentence boundaries so each request stays well inside the
  // TTS input limit. A full 8-12 minute script sent as one request comes back
  // without audio.
  splitNarrationForTTS(text, maxChars = 1800) {
    const sentences = String(text).replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]*\s*/g) || [];
    const chunks = [];
    let current = '';

    for (const sentence of sentences) {
      if (current && (current + sentence).length > maxChars) {
        chunks.push(current.trim());
        current = '';
      }
      // A single sentence longer than the limit still has to go somewhere.
      current += sentence;
    }
    if (current.trim()) {
      chunks.push(current.trim());
    }

    return chunks.length > 0 ? chunks : [String(text)];
  }

  // Microsoft Edge neural voices. Free, unlimited, no API key. Chunked the same
  // way as Gemini so very long scripts stay inside per-request limits.
  async generateEdgeTTS(text, outputPath) {
    const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
    const voice = process.env.EDGE_TTS_VOICE || 'en-US-AndrewNeural';

    // Documentary narration is slower and lower than a voice's default read,
    // which is tuned for assistant-style chirpiness. Edge exposes SSML prosody
    // for free and this was previously sending none, so every video was narrated
    // at conversational pace and pitch.
    const prosody = {};
    if (process.env.EDGE_TTS_RATE) prosody.rate = process.env.EDGE_TTS_RATE;
    if (process.env.EDGE_TTS_PITCH) prosody.pitch = process.env.EDGE_TTS_PITCH;
    if (process.env.EDGE_TTS_VOLUME) prosody.volume = process.env.EDGE_TTS_VOLUME;
    const hasProsody = Object.keys(prosody).length > 0;
    // The Edge websocket drops long synthesis requests part-way through
    // ("no turn.end received"), so keep each request short.
    const chunks = this.splitNarrationForTTS(text, 1200);

    this.logger.info(`Edge TTS: ${chunks.length} chunk(s), voice ${voice}${hasProsody ? `, prosody ${JSON.stringify(prosody)}` : ''}`);

    const partPaths = [];
    for (let i = 0; i < chunks.length; i++) {
      const partPath = `${outputPath}.part${i}.mp3`;
      let buffer = null;
      let lastError = null;

      // Transient socket drops are common; retry before failing the whole run.
      for (let attempt = 1; attempt <= 3 && !buffer; attempt++) {
        try {
          const tts = new MsEdgeTTS();
          // 96kbit is the highest MP3 Edge offers and costs nothing extra. The
          // narration is the only audio in the video, so it carries the whole mix.
          await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
          const { audioStream } = hasProsody
            ? await tts.toStream(chunks[i], prosody)
            : await tts.toStream(chunks[i]);

          const buffers = [];
          const collected = await new Promise((resolve, reject) => {
            audioStream.on('data', (c) => buffers.push(c));
            audioStream.on('end', () => resolve(Buffer.concat(buffers)));
            audioStream.on('error', reject);
          });

          if (collected.length === 0) {
            throw new Error('empty audio stream');
          }
          buffer = collected;
        } catch (error) {
          lastError = error;
          this.logger.warn(`Edge TTS chunk ${i + 1}/${chunks.length} attempt ${attempt} failed: ${error.message}`);
          await new Promise(r => setTimeout(r, 2000 * attempt));
        }
      }

      if (!buffer) {
        throw new Error(`Edge TTS failed for chunk ${i + 1}/${chunks.length}: ${lastError?.message}`);
      }

      await fs.writeFile(partPath, buffer);
      partPaths.push(partPath);
      this.logger.info(`Edge TTS chunk ${i + 1}/${chunks.length} ok (${Math.round(buffer.length / 1024)} KB)`);
    }

    if (partPaths.length === 1) {
      await fs.rename(partPaths[0], outputPath);
    } else {
      // Concat demuxer needs a list file; re-encode so the joins are clean.
      const listPath = `${outputPath}.concat.txt`;
      // The concat demuxer resolves each entry relative to the LIST FILE's
      // directory, so full paths get doubled. The parts live beside the list.
      await fs.writeFile(listPath, partPaths.map(p => `file '${path.basename(p)}'`).join('\n'));
      await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:a', 'libmp3lame', '-q:a', '2', outputPath]);
      await fs.unlink(listPath).catch(() => {});
      await Promise.all(partPaths.map(p => fs.unlink(p).catch(() => {})));
    }

    this.logger.info('Edge TTS generation complete');
    return outputPath;
  }

  async generateGeminiTTS(text, outputPath) {
    const model = process.env.GEMINI_TTS_MODEL || 'gemini-3.1-flash-tts-preview';
    const voiceName = process.env.GEMINI_TTS_VOICE || 'Kore';
    const chunks = this.splitNarrationForTTS(text);

    if (chunks.length > 1) {
      this.logger.info(`Narration split into ${chunks.length} TTS requests (${text.length} chars)`);
    }

    const pcmBuffers = [];
    for (let i = 0; i < chunks.length; i++) {
      const response = await this.gemini.models.generateContent({
        model,
        contents: [{ parts: [{ text: chunks[i] }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName }
            }
          }
        }
      });

      // The audio is NOT always the first part — a text part is often returned
      // alongside it, so search the parts rather than indexing into [0].
      const parts = response.candidates?.[0]?.content?.parts || [];
      const audioData = parts.find(part => part.inlineData?.data)?.inlineData?.data;
      if (!audioData) {
        const finishReason = response.candidates?.[0]?.finishReason || 'unknown';
        throw new Error(`Gemini TTS returned no audio data for chunk ${i + 1}/${chunks.length} (finishReason: ${finishReason})`);
      }

      pcmBuffers.push(Buffer.from(audioData, 'base64'));
      this.logger.info(`TTS chunk ${i + 1}/${chunks.length} complete`);
    }

    // Gemini returns raw PCM (24kHz, mono, 16-bit). Raw PCM concatenates
    // directly, so the chunks join seamlessly before a single encode.
    const pcmPath = outputPath + '.pcm';
    await fs.writeFile(pcmPath, Buffer.concat(pcmBuffers));
    await runFFmpeg(['-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcmPath, outputPath]);
    await fs.unlink(pcmPath).catch(() => {});

    this.logger.info('Gemini TTS generation complete');
    return outputPath;
  }

  async generateVisualAssets(prompt, style = "ethereal", count = 1) {
    this.logger.info(`Generating ${count} visual assets with style: ${style}`);

    try {
      if (!this.openai && !this.gemini) {
        return await this.simulateVisualAssets(prompt, style, count);
      }

      const enhancedPrompt = this.enhanceVisualPrompt(prompt, style);
      const localPaths = [];

      for (let i = 0; i < count; i++) {
        const imagePath = path.join(__dirname, '..', 'data', 'assets', `visual_${Date.now()}_${i}.png`);
        await this.generateImage(enhancedPrompt, imagePath);
        localPaths.push(imagePath);
      }

      this.logger.info(`Generated ${localPaths.length} visual assets`);
      return localPaths;
    } catch (error) {
      this.logger.error('Visual asset generation failed:', error);
      return await this.simulateVisualAssets(prompt, style, count);
    }
  }

  async generateImage(prompt, imagePath) {
    await fs.mkdir(path.dirname(imagePath), { recursive: true });

    if (this.openai) {
      return await this.generateOpenAIImage(prompt, imagePath);
    }

    if (this.gemini) {
      try {
        return await this.generateGeminiImage(prompt, imagePath);
      } catch (geminiError) {
        // Free-tier image quota is 0, so this is the normal path, not an edge case.
        this.logger.warn(`Gemini image generation unavailable (${String(geminiError.message).slice(0, 80)}); using Pollinations`);
      }
    }

    return await this.generatePollinationsImage(prompt, imagePath);
  }

  // Pollinations.ai: free image generation, no API key, no quota.
  async generatePollinationsImage(prompt, imagePath) {
    const seed = Math.floor(Math.random() * 1e9);
    const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt)
      + `?width=1920&height=1080&nologo=true&seed=${seed}`;

    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) {
      throw new Error(`Pollinations returned HTTP ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 1024) {
      throw new Error(`Pollinations returned ${buffer.length} bytes (not a usable image)`);
    }

    await fs.writeFile(imagePath, buffer);
    this.logger.info(`Pollinations image saved (${Math.round(buffer.length / 1024)} KB)`);
    return imagePath;
  }

  async generateOpenAIImage(prompt, imagePath) {
    const response = await this.openai.images.generate({
      model: "gpt-image-2",
      prompt: prompt,
      n: 1,
      size: "1536x1024",
      quality: "high",
    });

    if (response.data[0].b64_json) {
      const buffer = Buffer.from(response.data[0].b64_json, 'base64');
      await fs.writeFile(imagePath, buffer);
    } else {
      await this.downloadImage(response.data[0].url, imagePath);
    }

    return imagePath;
  }

  async generateGeminiImage(prompt, imagePath) {
    const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';

    const response = await this.gemini.models.generateContent({
      model,
      contents: prompt
    });

    const parts = response.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(part => part.inlineData?.data);
    if (!imagePart) {
      throw new Error('Gemini image generation returned no image data');
    }

    await fs.writeFile(imagePath, Buffer.from(imagePart.inlineData.data, 'base64'));
    return imagePath;
  }

  enhanceVisualPrompt(prompt, style) {
    const styleEnhancements = {
      ethereal: "ethereal, dreamy, mystical, soft lighting, floating particles, cosmic background",
      modern: "modern, clean, minimalist, professional, sleek design, contemporary",
      animated: "animated style, cartoon, vibrant colors, expressive, dynamic",
      cinematic: "cinematic lighting, dramatic, movie poster style, high contrast",
      abstract: "abstract art, geometric shapes, gradient colors, artistic composition"
    };

    const enhancement = styleEnhancements[style] || styleEnhancements.ethereal;
    return `${prompt}, ${enhancement}, high quality, 16:9 aspect ratio, digital art`;
  }

  async downloadImage(url, outputPath) {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  async generateVideo(script, visualAssets, audioPath, outputPath) {
    this.logger.info('Generating video from assets...');
    
    try {
      // Try Replicate for video generation first
      if (this.replicate && this.replicate.auth) {
        return await this.generateReplicateVideo(script, visualAssets, audioPath, outputPath);
      }
      
      // Real stock footage beats static slides. Static gradient slideshows are
      // exactly the profile YouTube's 2026 inauthentic-content policy targets.
      if (process.env.USE_STOCK_BROLL === 'true' && process.env.PEXELS_API_KEY) {
        try {
          return await this.generateStockFootageVideo(script, audioPath, outputPath);
        } catch (brollError) {
          this.logger.warn(`Stock footage assembly failed (${brollError.message}); falling back to slideshow`);
        }
      }

      // Fallback to simple slideshow with Playwright
      return await this.generateSlideshowVideo(script, visualAssets, audioPath, outputPath);
    } catch (error) {
      this.logger.error('Video generation failed:', error);
      return await this.simulateVideoGeneration(script, visualAssets, audioPath, outputPath);
    }
  }

  async generateReplicateVideo(script, visualAssets, audioPath, outputPath) {
    const output = await this.replicate.run(
      "wan-video/wan-2.7-i2v",
      {
        input: {
          image: visualAssets[0],
          prompt: script.title || "smooth cinematic motion",
          duration: 5,
          resolution: "720p"
        }
      }
    );

    // Download the generated video
    if (output && output.length > 0) {
      await this.downloadVideo(output[0], outputPath);
      
      // Add audio track
      await this.addAudioToVideo(outputPath, audioPath, outputPath);
    }

    return outputPath;
  }

  // Pull search terms from the script so the footage actually relates to what is
  // being said, rather than being generic filler.
  buildBrollQueries(script, count) {
    const terms = [];
    const sections = script.mainContent?.sections || [];

    for (const section of sections) {
      if (section.title) terms.push(String(section.title));
    }
    for (const keyword of script.keywords || []) {
      terms.push(String(keyword));
    }
    if (script.title) terms.push(String(script.title));

    // Strip filler words that return nothing useful on a stock library.
    // NOTE: \w is ASCII-only, so a naive [^\w\s] strip shreds accented text
    // ("génie" -> "g nie"). Use a unicode-aware class instead.
    const cleaned = terms
      .map(t => t.replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\b(the|a|an|how|to|your|with|and|for|of|in|on|step|by|le|la|les|des|du|de|un|une|au|aux|et)\b/gi, ' ')
        .replace(/\s+/g, ' ').trim())
      .filter(t => t.length > 3);

    const unique = [...new Set(cleaned)];
    const queries = [];
    for (let i = 0; i < count; i++) {
      queries.push(unique[i % Math.max(unique.length, 1)] || 'technology abstract background');
    }
    return queries;
  }

  // Ask the LLM for concrete, filmable ENGLISH search terms.
  //
  // Deriving queries from section titles fails badly: stock libraries index in
  // English, so a French script searched Pexels for "La descente aux enfers" and
  // got unrelated clips. Abstract phrases have no footage in any language, so the
  // model is asked for physical, visible scenes instead.
  async generateVisualQueries(script, count) {
    const sections = (script.mainContent?.sections || []).map(s => s.title).filter(Boolean);
    const prompt = `You are choosing stock footage for a video titled "${script.title}".

Its sections are:
${sections.map((s, i) => `${i + 1}. ${s}`).join('\n')}

Return only valid JSON: { "queries": ["...", "..."] }

Give exactly ${count} stock-footage search queries. Rules:
- ENGLISH ONLY, whatever language the video is in. Stock libraries index in English.
- Each query is a PHYSICAL, FILMABLE SCENE: "empty football stadium at night",
  "close up hands counting money", "rain on a car window at night".
- 2-5 words. No abstractions ("decline", "genius", "downfall") — those have no footage.
- No named people, teams, or logos. Stock libraries have none, and it is a rights risk.
- Match the subject matter and mood of the sections, and vary the shots.`;

    try {
      const { AITextService } = require('./ai-text-service');
      const service = new AITextService(this.credentials || {});
      if (!service.isAvailable()) throw new Error('no text provider');

      const raw = await service.generateText(prompt, { maxTokens: 1024, temperature: 0.8, json: true });
      const text = String(raw).replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text);
      const queries = (parsed.queries || [])
        .map(q => String(q).trim())
        .filter(q => q.length > 2);

      if (queries.length === 0) throw new Error('no queries returned');

      this.logger.info(`Visual queries: ${queries.slice(0, 4).join(' | ')}${queries.length > 4 ? ' | ...' : ''}`);
      return Array.from({ length: count }, (_, i) => queries[i % queries.length]);
    } catch (error) {
      this.logger.warn(`Visual query generation failed (${error.message}); using title-derived terms`);
      return this.buildBrollQueries(script, count);
    }
  }

  async fetchPexelsClip(query, targetPath, orientation = 'landscape') {
    const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}`
      + `&per_page=10&orientation=${orientation}&size=medium`;

    const response = await fetch(url, {
      headers: { Authorization: process.env.PEXELS_API_KEY },
      signal: AbortSignal.timeout(60000)
    });
    if (!response.ok) {
      throw new Error(`Pexels search HTTP ${response.status}`);
    }

    const data = await response.json();
    const videos = data.videos || [];
    if (videos.length === 0) return null;

    const pick = videos[Math.floor(Math.random() * videos.length)];
    // Prefer ~1080p: 4K files are large and get downscaled anyway.
    // Portrait clips are 1080x1920, so the long edge is height, not width.
    const longEdge = f => (orientation === 'portrait' ? f.height : f.width);
    const file = (pick.video_files || [])
      .filter(f => longEdge(f) >= 1280 && f.file_type === 'video/mp4')
      .sort((a, b) => Math.abs(longEdge(a) - 1920) - Math.abs(longEdge(b) - 1920))[0];
    if (!file) return null;

    const clipResponse = await fetch(file.link, { signal: AbortSignal.timeout(180000) });
    if (!clipResponse.ok) return null;

    await fs.writeFile(targetPath, Buffer.from(await clipResponse.arrayBuffer()));
    return targetPath;
  }

  // Shared clip library across every render.
  //
  // Clips used to be downloaded into a per-production directory and deleted at
  // the end, so each video re-fetched ~30 files (about six minutes of wall clock)
  // even though dark documentary topics reuse the same visual vocabulary
  // constantly — night streets, storms, empty stadiums, archive paper. Keyed by
  // orientation + query, a second video on a related subject pays almost nothing.
  brollCacheDir() {
    return process.env.BROLL_CACHE_DIR || path.join(__dirname, '..', 'data', 'broll-cache');
  }

  cacheKeyFor(query, orientation) {
    const crypto = require('crypto');
    const normalized = String(query).trim().toLowerCase().replace(/\s+/g, ' ');
    const hash = crypto.createHash('sha1').update(`${orientation}:${normalized}`).digest('hex').slice(0, 16);
    return `${orientation}_${hash}.mp4`;
  }

  async fetchPexelsClipCached(query, orientation = 'landscape') {
    const dir = this.brollCacheDir();
    await fs.mkdir(dir, { recursive: true });
    const cached = path.join(dir, this.cacheKeyFor(query, orientation));

    try {
      const stat = await fs.stat(cached);
      if (stat.size > 0) {
        // Refresh mtime so the pruner treats reuse as recency, not age.
        const now = new Date();
        await fs.utimes(cached, now, now).catch(() => {});
        return cached;
      }
    } catch {
      // Not cached yet.
    }

    const saved = await this.fetchPexelsClip(query, cached, orientation);
    if (!saved) {
      // Pexels returned nothing usable; drop any zero-byte file it left behind so
      // the next run retries instead of reusing an empty "hit".
      await fs.unlink(cached).catch(() => {});
      return null;
    }
    return saved;
  }

  // Keeps the library bounded. Evicts least-recently-used first, which maps
  // directly onto "visual themes this channel has stopped covering".
  async pruneBrollCache() {
    const maxMb = Number(process.env.BROLL_CACHE_MAX_MB) || 4000;
    const dir = this.brollCacheDir();

    try {
      const names = await fs.readdir(dir);
      const files = [];
      for (const name of names) {
        if (!name.endsWith('.mp4')) continue;
        const full = path.join(dir, name);
        const stat = await fs.stat(full).catch(() => null);
        if (stat) files.push({ full, size: stat.size, atime: stat.mtimeMs });
      }

      let totalMb = files.reduce((sum, f) => sum + f.size, 0) / (1024 * 1024);
      if (totalMb <= maxMb) return;

      files.sort((a, b) => a.atime - b.atime);
      for (const file of files) {
        if (totalMb <= maxMb) break;
        await fs.unlink(file.full).catch(() => {});
        totalMb -= file.size / (1024 * 1024);
      }
      this.logger.info(`B-roll cache pruned to ~${Math.round(totalMb)} MB`);
    } catch {
      // A missing cache directory is not an error worth failing a render over.
    }
  }

  // Vertical 9:16 Short built from the script's hook. The hook is already written
  // as a self-contained 45-60s promise, which is exactly the Shorts format.
  async generateShortVideo(script, outputPath) {
    const hookText = typeof script.hook === 'object' ? script.hook?.text : script.hook;
    if (!hookText) {
      throw new Error('script has no hook to build a Short from');
    }

    const dir = path.dirname(outputPath);
    await fs.mkdir(dir, { recursive: true });

    const audioPath = outputPath.replace('.mp4', '_narration.mp3');
    await this.generateTTSAudio(String(hookText), audioPath);

    let seconds = await this.probeAudioDuration(audioPath);
    if (!seconds) {
      throw new Error('could not measure Short narration');
    }
    // Shorts are capped at 60s; trim the audio rather than shipping something
    // YouTube will reject or silently treat as a normal video.
    if (seconds > 59) {
      const trimmed = outputPath.replace('.mp4', '_narration_trim.mp3');
      await runFFmpeg(['-y', '-i', audioPath, '-t', '58', '-c:a', 'libmp3lame', '-q:a', '2', trimmed]);
      await fs.unlink(audioPath).catch(() => {});
      await fs.rename(trimmed, audioPath);
      seconds = 58;
      this.logger.info('Hook narration trimmed to 58s for Shorts limit');
    }

    const segment = Number(process.env.SHORT_SEGMENT_SECONDS) || 5;
    const totalSegments = Math.max(2, Math.ceil(seconds / segment));
    const segLen = seconds / totalSegments;


    const queries = await this.generateVisualQueries(script, Math.min(totalSegments, 8));
    const clips = [];
    for (let i = 0; i < queries.length; i++) {
      try {
        // Portrait clips share the same library, keyed separately by orientation.
        const saved = await this.fetchPexelsClipCached(queries[i], 'portrait');
        if (saved) clips.push(saved);
      } catch (error) {
        this.logger.warn(`Short clip ${i + 1} failed: ${error.message}`);
      }
    }
    if (clips.length === 0) {
      throw new Error('no portrait clips available');
    }
    this.logger.info(`Short: ${clips.length} clips, ${totalSegments} cuts over ${seconds.toFixed(0)}s`);

    const args = [];
    for (let seg = 0; seg < totalSegments; seg++) {
      const clip = clips[seg % clips.length];
      const offset = Math.floor(seg / clips.length) * segLen;
      args.push('-stream_loop', '-1', '-ss', offset.toFixed(2), '-t', segLen.toFixed(2), '-i', clip);
    }

    const filters = [];
    for (let i = 0; i < totalSegments; i++) {
      filters.push(
        `[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,`
        + `crop=1080:1920,setsar=1,fps=30,format=yuv420p[v${i}]`
      );
    }
    filters.push(Array.from({ length: totalSegments }, (_, i) => `[v${i}]`).join('')
      + `concat=n=${totalSegments}:v=1:a=0[vout]`);

    const silentPath = outputPath.replace('.mp4', '_silent.mp4');
    args.push(
      '-filter_complex', filters.join(';'),
      '-map', '[vout]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-r', '30', '-pix_fmt', 'yuv420p',
      silentPath
    );
    await runFFmpeg(['-y', ...args]);

    await this.addAudioToVideo(silentPath, audioPath, outputPath);
    await fs.unlink(silentPath).catch(() => {});
    await this.pruneBrollCache();

    this.logger.info('Short complete (1080x1920)');
    return outputPath;
  }

  async generateStockFootageVideo(script, audioPath, outputPath) {
    this.logger.info('Building video from stock footage...');

    const narrationSeconds = await this.probeAudioDuration(audioPath);
    if (!narrationSeconds) {
      throw new Error('no narration audio to time the footage against');
    }

    // Cut roughly every 8s so the picture keeps moving. A 13-minute video would
    // need ~100 clips at that rate, which is too many downloads, so fetch a
    // bounded set of unique clips and revisit them at different offsets.
    const targetSegment = Number(process.env.BROLL_SEGMENT_SECONDS) || 8;
    const totalSegments = Math.max(3, Math.ceil(narrationSeconds / targetSegment));
    const clipCount = Math.min(totalSegments, Number(process.env.BROLL_MAX_CLIPS) || 30);
    const segment = narrationSeconds / totalSegments;
    const queries = await this.generateVisualQueries(script, clipCount);
    this.logger.info(`Sourcing ${clipCount} clips for ${narrationSeconds.toFixed(0)}s of narration`);

    const clips = [];
    let reused = 0;
    for (let i = 0; i < queries.length; i++) {
      try {
        const before = await fs.stat(path.join(this.brollCacheDir(), this.cacheKeyFor(queries[i], 'landscape'))).catch(() => null);
        const saved = await this.fetchPexelsClipCached(queries[i]);
        if (saved) {
          clips.push(saved);
          if (before) reused++;
        }
      } catch (error) {
        this.logger.warn(`Clip ${i + 1} (“${queries[i]}”) failed: ${error.message}`);
      }
    }

    if (clips.length === 0) {
      throw new Error('no stock clips could be downloaded');
    }
    this.logger.info(`Sourced ${clips.length}/${clipCount} clips (${reused} from cache, ${clips.length - reused} downloaded)`);

    // Lay every segment on the timeline, cycling through the downloaded clips.
    // Each revisit starts a little further into the source so a reused clip does
    // not show the identical frames twice.
    const timeline = [];
    for (let seg = 0; seg < totalSegments; seg++) {
      const clip = clips[seg % clips.length];
      const pass = Math.floor(seg / clips.length);
      timeline.push({ clip, startOffset: pass * segment });
    }

    // Trim, scale, and crop each segment to exactly 1080p/30fps. Uniform
    // geometry is what makes concat safe.
    const args = [];
    for (const item of timeline) {
      args.push('-stream_loop', '-1', '-ss', item.startOffset.toFixed(2), '-t', segment.toFixed(2), '-i', item.clip);
    }

    const filters = timeline.map((_, i) =>
      `[${i}:v]scale=1920:1080:force_original_aspect_ratio=increase,`
      + `crop=1920:1080,setsar=1,fps=30,format=yuv420p[v${i}]`
    );
    filters.push(timeline.map((_, i) => `[v${i}]`).join('') + `concat=n=${timeline.length}:v=1:a=0[vout]`);

    const silentPath = outputPath.replace('.mp4', '_broll.mp4');
    args.push(
      '-filter_complex', filters.join(';'),
      '-map', '[vout]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-r', '30', '-pix_fmt', 'yuv420p',
      silentPath
    );
    await runFFmpeg(['-y', ...args]);

    await this.addAudioToVideo(silentPath, audioPath, outputPath);
    await fs.unlink(silentPath).catch(() => {});
    // The clips are NOT deleted — they are the shared library the next render
    // draws from. Only the size cap removes anything.
    await this.pruneBrollCache();

    this.logger.info('Stock footage video complete');
    return outputPath;
  }

  async generateSlideshowVideo(script, visualAssets, audioPath, outputPath) {
    this.logger.info('Creating slideshow video...');

    if (!(await checkFFmpeg())) {
      throw new Error(ffmpegInstallHint());
    }

    const { chromium } = require('playwright');
    // `npm install` fetches the playwright package but NOT its browser binaries,
    // and a machine may carry browser builds from a different playwright version.
    // Rather than hard-failing the whole render (which silently downgrades the
    // video to a placeholder), fall back to a locally installed Chrome.
    let browser;
    try {
      browser = await chromium.launch();
    } catch (launchError) {
      this.logger.warn(`Bundled Chromium unavailable (${launchError.message.split('\n')[0]}); falling back to installed Chrome`);
      browser = await chromium.launch({ channel: 'chrome' });
    }
    const slidesDir = path.join(path.dirname(outputPath), 'slides');

    try {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1920, height: 1080 });

      // Create HTML for slideshow (only real image files can be embedded)
      const imageAssets = await this.filterImageAssets(visualAssets);
      await page.setContent(this.createSlideshowHTML(script, imageAssets));

      // Freeze CSS transitions/animations so each still is captured fully rendered
      await page.addStyleTag({ content: '* { transition: none !important; animation: none !important; }' });
      await page.waitForTimeout(1000); // Wait for assets to load

      // Capture ONE still per slide instead of screenshotting at 30fps —
      // FFmpeg turns the stills into a crossfaded video in seconds.
      const slideCount = await page.evaluate(() => document.querySelectorAll('.slide').length);
      await fs.mkdir(slidesDir, { recursive: true });

      const stills = [];
      for (let i = 0; i < slideCount; i++) {
        await page.evaluate((index) => {
          document.querySelectorAll('.slide').forEach((slide, s) => {
            slide.classList.toggle('active', s === index);
          });
        }, i);

        const stillPath = path.join(slidesDir, `slide_${String(i).padStart(3, '0')}.png`);
        await page.screenshot({ path: stillPath });
        stills.push(stillPath);
      }

      const videoPath = outputPath.replace('.mp4', '_visual.mp4');
      // Prefer the real narration length. calculateScriptDuration() walks a script
      // shape the AI path does not produce, so it collapses to its 30s floor and
      // the -shortest mux then throws away minutes of finished narration.
      const probed = await this.probeAudioDuration(audioPath);
      const duration = probed || this.calculateScriptDuration(script);
      if (probed) {
        this.logger.info(`Matching slide track to narration length: ${probed.toFixed(1)}s`);
      } else {
        this.logger.warn(`Could not read narration length; estimating ${duration}s from word count`);
      }
      await this.renderSlidesToVideo(stills, duration, videoPath);

      // Add audio
      await this.addAudioToVideo(videoPath, audioPath, outputPath);

      return outputPath;
    } finally {
      await browser.close().catch(() => {});
      await this.cleanupDirectory(slidesDir);
    }
  }

  async renderSlidesToVideo(stills, totalDuration, videoPath) {
    if (stills.length === 0) {
      throw new Error('No slides to render');
    }

    const fade = 0.5;
    const perSlide = Math.max(2, totalDuration / stills.length);

    const args = ['-y'];
    for (const still of stills) {
      args.push('-loop', '1', '-t', perSlide.toFixed(2), '-framerate', '30', '-i', still);
    }

    if (stills.length === 1) {
      args.push('-vf', 'format=yuv420p', '-c:v', 'libx264', videoPath);
      await runFFmpeg(args);
      return videoPath;
    }

    // Chain crossfades: transition k starts fade seconds before slide k ends
    const filters = [];
    let prev = '[0:v]';
    for (let i = 1; i < stills.length; i++) {
      const out = `[v${i}]`;
      const offset = (i * (perSlide - fade)).toFixed(2);
      filters.push(`${prev}[${i}:v]xfade=transition=fade:duration=${fade}:offset=${offset}${out}`);
      prev = out;
    }
    filters.push(`${prev}format=yuv420p[vfinal]`);

    args.push(
      '-filter_complex', filters.join(';'),
      '-map', '[vfinal]',
      '-c:v', 'libx264',
      '-r', '30',
      videoPath
    );

    await runFFmpeg(args);
    return videoPath;
  }

  async filterImageAssets(visualAssets = []) {
    const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
    const images = [];

    for (const asset of visualAssets) {
      if (typeof asset !== 'string' || !imageExtensions.has(path.extname(asset).toLowerCase())) {
        continue;
      }

      try {
        await fs.access(asset);
        images.push(pathToFileURL(asset).href);
      } catch (error) {
        // Skip missing files
      }
    }

    return images;
  }

  createSlideshowHTML(script, visualAssets) {
    return `
<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            margin: 0;
            padding: 0;
            width: 1920px;
            height: 1080px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            font-family: 'Arial', sans-serif;
            overflow: hidden;
        }
        
        .slide {
            position: absolute;
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 2s ease-in-out;
        }
        
        .slide.active {
            opacity: 1;
        }
        
        .content {
            text-align: center;
            color: white;
            max-width: 80%;
        }
        
        h1 {
            font-size: 72px;
            margin-bottom: 30px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
        }
        
        h2 {
            font-size: 48px;
            margin-bottom: 20px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
        }
        
        p {
            font-size: 36px;
            line-height: 1.4;
            text-shadow: 1px 1px 2px rgba(0,0,0,0.5);
        }
        
        .background-image {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            object-fit: cover;
            opacity: 0.3;
            z-index: -1;
        }
        
        .particles {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            z-index: -1;
        }
        
        .particle {
            position: absolute;
            background: rgba(255,255,255,0.8);
            border-radius: 50%;
            animation: float 6s ease-in-out infinite;
        }
        
        @keyframes float {
            0%, 100% { transform: translateY(0px); }
            50% { transform: translateY(-20px); }
        }
    </style>
</head>
<body>
    <div class="particles"></div>
    
    <!-- Title Slide -->
    <div class="slide active">
        ${visualAssets[0] ? `<img class="background-image" src="${visualAssets[0]}" />` : ''}
        <div class="content">
            <h1>${script.title}</h1>
            <p>Ethereal Dreamscript</p>
        </div>
    </div>
    
    ${this.generateContentSlides(script, visualAssets).join('')}
    
    <!-- Subscribe Slide -->
    <div class="slide">
        <div class="content">
            <h2>✨ Subscribe for More Stories ✨</h2>
            <p>New content daily at 2:00 PM</p>
        </div>
    </div>
    
    <script>
        // Create floating particles
        function createParticles() {
            const container = document.querySelector('.particles');
            for (let i = 0; i < 20; i++) {
                const particle = document.createElement('div');
                particle.className = 'particle';
                particle.style.left = Math.random() * 100 + '%';
                particle.style.top = Math.random() * 100 + '%';
                particle.style.width = (Math.random() * 4 + 2) + 'px';
                particle.style.height = particle.style.width;
                particle.style.animationDelay = Math.random() * 6 + 's';
                container.appendChild(particle);
            }
        }
        
        let currentSlide = 0;
        const slides = document.querySelectorAll('.slide');
        
        function advanceAnimation() {
            slides[currentSlide].classList.remove('active');
            currentSlide = (currentSlide + 1) % slides.length;
            slides[currentSlide].classList.add('active');
        }
        
        window.advanceAnimation = advanceAnimation;
        createParticles();
    </script>
</body>
</html>`;
  }

  generateContentSlides(script, visualAssets) {
    const slides = [];
    
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach((section, index) => {
        const assetIndex = Math.min(index + 1, visualAssets.length - 1);
        
        slides.push(`
        <div class="slide">
            ${visualAssets[assetIndex] ? `<img class="background-image" src="${visualAssets[assetIndex]}" />` : ''}
            <div class="content">
                <h2>${section.title}</h2>
                ${this.formatSectionContent(section)}
            </div>
        </div>`);
      });
    }
    
    return slides;
  }

  formatSectionContent(section) {
    if (section.items && Array.isArray(section.items)) {
      return section.items.slice(0, 3).map(item => 
        `<p>${item.number}. ${item.title}</p>`
      ).join('');
    }
    
    if (section.steps && Array.isArray(section.steps)) {
      return section.steps.slice(0, 3).map(step => 
        `<p>${step.title}</p>`
      ).join('');
    }
    
    if (typeof section.content === 'string') {
      return `<p>${section.content.slice(0, 200)}${section.content.length > 200 ? '...' : ''}</p>`;
    }
    
    return '<p>Content coming soon...</p>';
  }

  calculateScriptDuration(script) {
    // Estimate duration based on word count (average 150 words per minute)
    let totalWords = 0;
    
    if (script.hook) totalWords += script.hook.text.split(' ').length;
    if (script.introduction) {
      totalWords += (script.introduction.greeting || '').split(' ').length;
      totalWords += (script.introduction.topicIntro || '').split(' ').length;
    }
    
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach(section => {
        if (typeof section.content === 'string') {
          totalWords += section.content.split(' ').length;
        }
        if (section.items) {
          section.items.forEach(item => {
            totalWords += (item.title + ' ' + item.description).split(' ').length;
          });
        }
        if (section.steps) {
          section.steps.forEach(step => {
            totalWords += (step.title + ' ' + step.description).split(' ').length;
          });
        }
      });
    }
    
    if (script.conclusion) {
      totalWords += script.conclusion.finalThought.split(' ').length;
    }
    
    // Convert to duration (150 words per minute)
    return Math.max(30, Math.ceil((totalWords / 150) * 60));
  }

  // Returns the audio duration in seconds, or null when it cannot be determined
  // (missing file, no ffprobe on PATH). Callers fall back to an estimate.
  async probeAudioDuration(audioPath) {
    if (!audioPath || !(await this.isUsableAudioFile(audioPath))) {
      return null;
    }

    return new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audioPath],
        (error, stdout) => {
          if (error) {
            return resolve(null);
          }
          const seconds = parseFloat(String(stdout).trim());
          resolve(Number.isFinite(seconds) && seconds > 0 ? seconds : null);
        }
      );
    });
  }

  // Optional backing track. A documentary narrated over pure silence reads as
  // unfinished; a bed at roughly -22dB under the voice is what makes it sound
  // produced. Drop licence-clear tracks into data/music/ and they are picked up
  // automatically — nothing is bundled, since music licensing is the user's call.
  async pickMusicBed() {
    if (process.env.MUSIC_BED === 'off') return null;
    const dir = process.env.MUSIC_DIR || path.join(__dirname, '..', 'data', 'music');
    try {
      const files = (await fs.readdir(dir)).filter(f => /\.(mp3|m4a|wav|ogg|flac)$/i.test(f));
      if (files.length === 0) return null;
      const pick = files[Math.floor(Math.random() * files.length)];
      this.logger.info(`Music bed: ${pick}`);
      return path.join(dir, pick);
    } catch {
      return null;
    }
  }

  async addAudioToVideo(videoPath, audioPath, outputPath) {
    const hasRealAudio = await this.isUsableAudioFile(audioPath);

    if (!hasRealAudio) {
      this.logger.warn('No narration audio available — producing silent video. Configure OpenAI, ElevenLabs, or Azure Speech for narration.');
      if (videoPath !== outputPath) {
        await fs.copyFile(videoPath, outputPath);
      }
      return outputPath;
    }

    // FFmpeg cannot write to its own input, so mux to a temp file when paths collide
    const muxPath = outputPath === videoPath
      ? outputPath.replace(/\.mp4$/i, '_muxed.mp4')
      : outputPath;

    // Edge TTS only emits 24kHz MONO, and muxing it straight through shipped
    // videos at 24kHz/74kbps against YouTube's 48kHz stereo spec — which is why
    // the narration sounded thin regardless of which voice was used.
    //
    // loudnorm targets -14 LUFS, YouTube's normalisation point. Below it YouTube
    // leaves the video quiet relative to every other channel; above it, YouTube
    // turns it down anyway and the extra level is wasted.
    const music = await this.pickMusicBed();
    const args = ['-y', '-i', videoPath, '-i', audioPath];

    if (music) {
      args.push('-stream_loop', '-1', '-i', music);
      args.push('-filter_complex',
        // Narration is normalised first so the bed sits at a fixed distance
        // beneath it rather than beneath whatever level the TTS happened to emit.
        '[1:a]aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=11[voice];'
        + `[2:a]aresample=48000,volume=${process.env.MUSIC_BED_VOLUME || '0.08'}[bed];`
        + '[voice][bed]amix=inputs=2:duration=first:dropout_transition=0,'
        + 'loudnorm=I=-14:TP=-1.5:LRA=11,aformat=channel_layouts=stereo[aout]');
      args.push('-map', '0:v', '-map', '[aout]');
    } else {
      args.push('-af', 'aresample=48000,loudnorm=I=-14:TP=-1.5:LRA=11,aformat=channel_layouts=stereo');
    }

    args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-shortest', muxPath);
    await runFFmpeg(args);

    if (muxPath !== outputPath) {
      await fs.rename(muxPath, outputPath);
    }

    this.logger.info('Audio added to video successfully');
    return outputPath;
  }

  async isUsableAudioFile(audioPath) {
    if (typeof audioPath !== 'string' || audioPath.endsWith('.info')) {
      return false;
    }

    try {
      const stats = await fs.stat(audioPath);
      return stats.isFile() && stats.size > 0;
    } catch (error) {
      return false;
    }
  }

  async downloadVideo(url, outputPath) {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  async cleanupDirectory(dirPath) {
    try {
      const files = await fs.readdir(dirPath);
      for (const file of files) {
        await fs.unlink(path.join(dirPath, file));
      }
      await fs.rmdir(dirPath);
    } catch (error) {
      this.logger.warn('Cleanup failed:', error.message);
    }
  }

  async generateThumbnail(script, style = "ethereal") {
    this.logger.info('Generating custom thumbnail...');

    try {
      if (!this.openai && !this.gemini) {
        return await this.simulateThumbnailGeneration(script, style);
      }

      const prompt = `YouTube thumbnail for "${script.title}", ${style} style, eye-catching, high contrast text, professional design, clickable, engaging`;
      const thumbnailPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_${Date.now()}.png`);

      await this.generateImage(prompt, thumbnailPath);

      return {
        path: thumbnailPath,
        dimensions: { width: 1536, height: 1024 },
        fileSize: await this.getFileSize(thumbnailPath)
      };
    } catch (error) {
      this.logger.error('Thumbnail generation failed:', error);
      return await this.simulateThumbnailGeneration(script, style);
    }
  }

  async getFileSize(filePath) {
    const stats = await fs.stat(filePath);
    return stats.size;
  }

  // Simulation methods for when APIs are not available
  async simulateTTSGeneration(text, outputPath) {
    this.logger.info('Simulating TTS generation...');
    
    const infoPath = outputPath + '.info';
    await fs.writeFile(infoPath, JSON.stringify({
      message: 'AI TTS audio would be generated here',
      text: text.substring(0, 100) + '...',
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return infoPath;
  }

  async simulateVisualAssets(prompt, style, count) {
    this.logger.info(`Simulating ${count} visual assets...`);
    
    const paths = [];
    for (let i = 0; i < count; i++) {
      const assetPath = path.join(__dirname, '..', 'data', 'assets', `visual_sim_${Date.now()}_${i}.info`);
      
      await fs.writeFile(assetPath, JSON.stringify({
        message: 'AI visual asset would be generated here',
        prompt: prompt,
        style: style,
        timestamp: new Date().toISOString()
      }, null, 2));
      
      paths.push(assetPath);
    }
    
    return paths;
  }

  async simulateVideoGeneration(script, visualAssets, audioPath, outputPath) {
    this.logger.info('Simulating video generation...');
    
    const infoPath = outputPath + '.info';
    await fs.writeFile(infoPath, JSON.stringify({
      message: 'AI video would be generated here',
      script: script.title,
      visualAssets: visualAssets.length,
      audioPath: audioPath,
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return infoPath;
  }

  async simulateThumbnailGeneration(script, style) {
    this.logger.info('Simulating thumbnail generation...');
    
    const thumbnailPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_sim_${Date.now()}.info`);
    await fs.mkdir(path.dirname(thumbnailPath), { recursive: true });
    
    await fs.writeFile(thumbnailPath, JSON.stringify({
      message: 'AI thumbnail would be generated here',
      title: script.title,
      style: style,
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return {
      path: thumbnailPath,
      dimensions: { width: 1792, height: 1024 },
      fileSize: 1024,
      simulated: true
    };
  }
}

module.exports = { AIVideoGenerator };