const OpenAI = require('openai');
const { Logger } = require('./logger');

const PROVIDERS = {
  // Free tiers with no credit card required. Listed first so they win the
  // env-key scan in _init() over paid providers.
  groq: {
    name: 'Groq (free tier)',
    baseURL: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b', 'moonshotai/kimi-k2-instruct'],
    envKey: 'GROQ_API_KEY',
  },
  cerebras: {
    name: 'Cerebras (free tier)',
    baseURL: 'https://api.cerebras.ai/v1',
    // Verified against GET https://api.cerebras.ai/v1/models on this account.
    defaultModel: 'gpt-oss-120b',
    models: ['gpt-oss-120b', 'zai-glm-4.7', 'gemma-4-31b'],
    envKey: 'CEREBRAS_API_KEY',
  },
  openai: {
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.5',
    models: ['gpt-5.5', 'gpt-5.5-instant', 'gpt-5.4'],
    envKey: 'OPENAI_API_KEY',
  },
  openrouter: {
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-5.5',
    models: ['openai/gpt-5.5', 'anthropic/claude-opus-4-8', 'google/gemini-3.5-flash', 'moonshotai/kimi-k2.6', 'zhipu/glm-5'],
    envKey: 'OPENROUTER_API_KEY',
  },
  kimi: {
    name: 'Kimi (Moonshot AI)',
    baseURL: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k2.6',
    models: ['kimi-k2.6', 'kimi-k2.5', 'moonshot-v1-auto'],
    envKey: 'MOONSHOT_API_KEY',
  },
  mimo: {
    name: 'MiMo (Xiaomi)',
    baseURL: 'https://api.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.5-pro',
    models: ['mimo-v2.5-pro', 'mimo-v2.5'],
    envKey: 'MIMO_API_KEY',
  },
  glm: {
    name: 'GLM (Zhipu AI)',
    baseURL: 'https://api.z.ai/api/paas/v4/',
    defaultModel: 'glm-5',
    models: ['glm-5', 'glm-5.1'],
    envKey: 'GLM_API_KEY',
  },
};

class AITextService {
  constructor(credentials = {}) {
    this.logger = new Logger('AITextService');
    this.client = null;
    this.gemini = null;
    this.model = null;
    this.providerName = null;

    this._init(credentials);
  }

  _init(credentials) {
    const provider = credentials.aiProvider?.provider;
    const apiKey = credentials.aiProvider?.apiKey;
    const model = credentials.aiProvider?.model;

    if (provider && PROVIDERS[provider] && apiKey) {
      return this._initOpenAICompatible(PROVIDERS[provider], apiKey, model);
    }

    const geminiKey = credentials.gemini?.apiKey || process.env.GEMINI_API_KEY;

    // Without an explicit preference the loop below picks whichever provider
    // happens to be declared first in PROVIDERS, so a fast-but-weak free tier
    // silently outranks a stronger model whose key is also present. Script
    // quality is the whole product here, so let the channel pin its writer.
    const preferred = process.env.AI_TEXT_PROVIDER?.trim().toLowerCase();
    if (preferred) {
      if (preferred === 'gemini' && geminiKey) {
        return this._initGemini(geminiKey, credentials.gemini?.model);
      }
      const preset = PROVIDERS[preferred];
      const key = preset && process.env[preset.envKey];
      if (key) {
        return this._initOpenAICompatible(preset, key);
      }
      this.logger.warn(`AI_TEXT_PROVIDER="${preferred}" has no usable key; falling back to auto-detection`);
    }

    for (const [, preset] of Object.entries(PROVIDERS)) {
      const key = process.env[preset.envKey];
      if (key) {
        return this._initOpenAICompatible(preset, key);
      }
    }

    if (geminiKey) {
      return this._initGemini(geminiKey, credentials.gemini?.model);
    }

    this.logger.warn('No AI text provider configured — text generation unavailable');
  }

  _initOpenAICompatible(preset, apiKey, model) {
    this.client = new OpenAI({ apiKey, baseURL: preset.baseURL });
    this.model = model || preset.defaultModel;
    this.providerName = preset.name;
    this.logger.info(`${preset.name} initialized (model: ${this.model})`);
  }

  _initGemini(apiKey, model) {
    try {
      const { GoogleGenAI } = require('@google/genai');
      this.gemini = new GoogleGenAI({ apiKey });
      this.model = model || 'gemini-3.5-flash';
      this.providerName = 'Google Gemini';
      this.logger.info(`Gemini initialized (model: ${this.model})`);
    } catch (error) {
      this.logger.error('Failed to initialize Gemini:', error.message);
    }
  }

  async generateText(prompt, options = {}) {
    // Groq's edge intermittently returns 403 "Access denied" and recovers on the
    // next call. Retry the good provider before dropping to a weaker one.
    let lastPrimaryError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this._generateTextPrimary(prompt, options);
      } catch (error) {
        lastPrimaryError = error;
        const retriable = /403|429|500|502|503|504|timeout|fetch failed|network/i.test(String(error.message));
        if (!retriable || attempt === 3) break;
        this.logger.warn(`${this.providerName || 'Primary'} attempt ${attempt} failed (${String(error.message).slice(0, 60)}); retrying`);
        await new Promise(r => setTimeout(r, 1500 * attempt));
      }
    }

    try {
      throw lastPrimaryError;
    } catch (error) {
      // Gemini's free tier allows 20 text requests per DAY. Rather than letting
      // that collapse the whole pipeline into template output, fall back to
      // Pollinations, which is free and needs no API key at all.
      if (process.env.TEXT_FALLBACK === 'off') {
        throw error;
      }
      this.logger.warn(`${this.providerName || 'Primary'} text generation failed (${String(error.message).slice(0, 70)}); falling back to Pollinations`);
      return await this._generatePollinationsText(prompt, options);
    }
  }

  // Free, keyless, OpenAI-compatible endpoint.
  async _generatePollinationsText(prompt, options = {}) {
    const response = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.POLLINATIONS_TEXT_MODEL || 'openai-fast',
        messages: [{ role: 'user', content: prompt }],
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens || 2048
      }),
      signal: AbortSignal.timeout(300000)
    });

    if (!response.ok) {
      throw new Error(`Pollinations text HTTP ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Pollinations text returned no content');
    }

    this.logger.info('Text generated via Pollinations (free fallback)');
    return content;
  }

  async _generateTextPrimary(prompt, options = {}) {
    const model = options.model || this.model;
    const maxTokens = options.maxTokens || 2048;
    const temperature = options.temperature ?? 0.7;

    if (this.gemini) {
      const response = await this.gemini.models.generateContent({
        model,
        contents: prompt,
        config: { maxOutputTokens: maxTokens, temperature },
      });
      return response.text;
    }

    if (!this.client) {
      throw new Error('No AI text provider configured');
    }

    // Llama-class models emit invalid JSON often enough to matter (unescaped
    // quotes, trailing commas) — especially in French, where apostrophes are
    // everywhere. Native JSON mode makes valid output a guarantee instead of a
    // hope, so the callers stop falling back to templates.
    const wantsJson = options.json ?? /only valid JSON/i.test(prompt);

    const response = await this.client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature,
      ...(wantsJson ? { response_format: { type: 'json_object' } } : {})
    });

    return response.choices[0].message.content;
  }

  isAvailable() {
    return !!(this.client || this.gemini);
  }
}

module.exports = { AITextService, PROVIDERS };
