/* global fetch, AbortSignal */
// fetch and AbortSignal are Node globals from v18 onward; package.json already
// pins engines.node to >=18. Declared here because the shared eslint config
// predates them.
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
  mistral: {
    name: 'Mistral (free Experiment tier)',
    baseURL: 'https://api.mistral.ai/v1',
    // Mistral Large 2 was trained predominantly on French text rather than
    // English, so for a French-language channel it is the strongest free option
    // available — and the free tier is metered in tokens per MONTH (~1B) rather
    // than Gemini's 20 requests per DAY. Rate limiting is per-minute, which
    // matters not at all at a few scripts a day.
    defaultModel: 'mistral-large-latest',
    models: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'],
    envKey: 'MISTRAL_API_KEY',
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
    this.agentRouter = null;
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
      if (preferred === 'agentrouter' && process.env.AGENT_ROUTER_KEY) {
        return this._initAgentRouter();
      }
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

  _initAgentRouter() {
    this.agentRouter = {
      baseUrl: (process.env.AGENT_ROUTER_URL || 'https://agent-router-backend-1023201593264.europe-west1.run.app').replace(/\/+$/, ''),
      key: process.env.AGENT_ROUTER_KEY,
      // ReasoningDelegationHigh — the deep multi-step agent. Costs the most
      // credits per call but is the only tier worth trusting with facts about
      // real people.
      agentId: process.env.AGENT_ROUTER_AGENT_ID || '7ca1324c-13f3-4404-8078-60b8ba83b9dd'
    };
    this.model = this.agentRouter.agentId;
    this.providerName = 'AgentRouter (A2A)';
    this.logger.info(`AgentRouter initialized (agent: ${this.agentRouter.agentId})`);
  }

  // The router is async: POST starts a task, then the result is polled. There is
  // no streaming and no synchronous mode, so a long script means a long poll.
  async _generateAgentRouterText(prompt) {
    const { baseUrl, key, agentId } = this.agentRouter;
    const headers = { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };

    // Every agent declares its own input field — ReasoningDelegationHigh wants
    // "query", Medium wants "task", ResearchAgent wants "topic", TaskPlanner
    // wants "task_description". Rather than pin one, start with the configured
    // guess and let the 400 tell us the real name.
    const start = async (field) => fetch(`${baseUrl}/api/a2a/call`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ agent_id: agentId, payload: { [field]: prompt } }),
      signal: AbortSignal.timeout(120000)
    });

    let field = process.env.AGENT_ROUTER_PAYLOAD_FIELD || 'query';
    let startRes = await start(field);

    if (startRes.status === 400) {
      const detail = await startRes.text();
      const required = detail.match(/'([A-Za-z0-9_]+)' is a required property/)?.[1];
      if (!required || required === field) {
        throw new Error(`AgentRouter rejected payload: ${detail.slice(0, 140)}`);
      }
      this.logger.info(`AgentRouter agent expects "${required}"; retrying`);
      field = required;
      startRes = await start(field);
    }

    if (!startRes.ok) {
      throw new Error(`AgentRouter call HTTP ${startRes.status}`);
    }
    const started = await startRes.json();
    const taskId = started.task_id;
    if (!taskId) {
      throw new Error(`AgentRouter returned no task_id: ${JSON.stringify(started).slice(0, 120)}`);
    }

    const pollMs = Number(process.env.AGENT_ROUTER_POLL_MS) || 5000;
    const timeoutMs = Number(process.env.AGENT_ROUTER_TIMEOUT_MS) || 900000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, pollMs));
      const pollRes = await fetch(`${baseUrl}/api/a2a/tasks/${taskId}`, {
        headers,
        signal: AbortSignal.timeout(60000)
      });
      if (!pollRes.ok) continue;

      const task = await pollRes.json();
      if (task.status === 'COMPLETED') {
        const result = task.result;
        const text = typeof result === 'string' ? result : (result?.output ?? result?.text ?? JSON.stringify(result));
        if (!text) throw new Error('AgentRouter completed with empty result');
        return text;
      }
      if (task.status === 'FAILED') {
        throw new Error(`AgentRouter task failed: ${task.error_code || 'unknown'}`);
      }
    }

    throw new Error(`AgentRouter task timed out after ${Math.round(timeoutMs / 1000)}s`);
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

    if (this.agentRouter) {
      // The router exposes no temperature or token controls; the agent decides.
      return await this._generateAgentRouterText(prompt);
    }

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
    return !!(this.client || this.gemini || this.agentRouter);
  }
}

module.exports = { AITextService, PROVIDERS };
