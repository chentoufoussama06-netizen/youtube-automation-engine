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
    // openai/gpt-oss-120b silently returns an EMPTY completion (not an error —
    // Groq's own json_validate_failed on an empty string) for this channel's
    // subject matter: real deaths, disasters, violence. It's a content-safety
    // behaviour on that specific model, not a formatting bug — no amount of
    // prompt rewording fixed it (tested 2026-09-04). groq/compound does not
    // hit the same wall on the identical prompt.
    // 2026-10-06: groq/compound was withdrawn from this key (404 "does not
    // exist"), which silently took Groq out of the fallback chain.
    defaultModel: 'openai/gpt-oss-120b',
    models: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'],
    envKey: 'GROQ_API_KEY',
    // groq/compound rejects any request above this outright (400). Clamping
    // a big request down to fit made it worse, not better: a full documentary
    // script silently truncates mid-JSON at 8192 tokens ("Unexpected end of
    // JSON input") instead of failing loudly. largeModel below has no such
    // cap and, tested 2026-09-04, does NOT hit the content-moderation wall
    // that blocks openai/gpt-oss-120b specifically on the short visceral-hook
    // prompt — that wall only showed up on the small, punchy-hook call, not
    // the long neutral-toned script call. So: big requests route to
    // largeModel at full size, small ones stay on compound.
    maxOutputTokens: 8192,
    largeModel: 'openai/gpt-oss-120b',
  },
  cerebras: {
    name: 'Cerebras (free tier)',
    baseURL: 'https://api.cerebras.ai/v1',
    // 2026-08-29: every model on this key answers 402 "Payment required to
    // access this resource", so Cerebras is unusable until billing is added.
    // Kept here (rather than deleted) so it resumes working the moment it is
    // funded — the fallback chain simply skips it while it fails.
    defaultModel: 'gpt-oss-120b',
    models: ['gpt-oss-120b', 'gemma-4-31b'],
    envKey: 'CEREBRAS_API_KEY',
  },
  mistral: {
    name: 'Mistral (free Experiment tier)',
    baseURL: 'https://api.mistral.ai/v1',
    // Mistral is trained predominantly on French text rather than English, so
    // for a French-language channel it is the strongest free option available —
    // and the free tier is metered in tokens per MONTH (~1B) rather than
    // Gemini's 20 requests per DAY. Rate limiting is per-minute, which matters
    // not at all at a few scripts a day.
    //
    // 2026-08-29: mistral-large-latest was dropped from the free Experiment
    // tier and now answers 403 "This model is not available in your
    // subscription tier". That single stale id failed every job in the queue.
    // mistral-medium-latest is the strongest model the tier still serves and
    // verified clean on a French documentary prompt.
    defaultModel: 'mistral-medium-latest',
    models: ['mistral-medium-latest', 'mistral-small-latest', 'magistral-small-latest', 'ministral-8b-latest'],
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
    // The SDK defaults to a 10-minute timeout AND 2 internal retries, which
    // stack underneath generateText()'s own 3-attempt loop: one wedged socket
    // could hold the worker for ~90 minutes emitting no log line at all. That
    // is how the Sala render was lost - 17 minutes of silence with no way to
    // tell a working call from a dead one. Retries belong to generateText, so
    // the client gets none, and the timeout is an explicit budget.
    this.client = new OpenAI({
      apiKey,
      baseURL: preset.baseURL,
      timeout: Number(process.env.AI_TEXT_TIMEOUT_MS) || 480000,
      maxRetries: 0
    });
    this.model = model || preset.defaultModel;
    this.providerName = preset.name;
    this.maxOutputTokens = preset.maxOutputTokens || null;
    this.largeModel = preset.largeModel || null;
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
        // The SDK is constructed with maxRetries:0 above, so its own retry of
                // transient socket failures is gone and this regex is the only thing
                // left covering them. It did not match the OpenAI SDK's
                // APIConnectionError, whose message is the bare string "Connection
                // error." - so a dropped socket fell straight through to the weaker
                // fallback provider and, when that was also down, killed the job.
                const retriable = /403|429|500|502|503|504|timeout|timed out|fetch failed|network|connection|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|aborted/i
                  .test(String(error.message));
        if (!retriable || attempt === 3) break;
        this.logger.warn(`${this.providerName || 'Primary'} attempt ${attempt} failed (${String(error.message).slice(0, 60)}); retrying`);
        await new Promise(r => setTimeout(r, 1500 * attempt));
      }
    }

    try {
      throw lastPrimaryError;
    } catch (error) {
      // Gemini's free tier allows 20 text requests per DAY. Rather than letting
      // that collapse the whole pipeline into template output, fall back.
      if (process.env.TEXT_FALLBACK === 'off') {
        throw error;
      }

      // Before dropping to the keyless endpoint, spend the keys already in
      // .env. The chain used to be primary -> Pollinations and nothing else,
      // so on 2026-08-29 a stale Mistral model id (403) plus Pollinations
      // retiring its free text API (402) failed every job in the queue while
      // working Groq credentials sat unused in the same file.
      const recovered = await this._generateWithBackupProviders(prompt, options);
      if (recovered !== null) {
        return recovered;
      }

      this.logger.warn(`${this.providerName || 'Primary'} text generation failed (${String(error.message).slice(0, 70)}); falling back to Pollinations`);
      return await this._generatePollinationsText(prompt, options);
    }
  }

  // Try every other configured OpenAI-compatible provider in turn. Returns the
  // generated text, or null if none of them could produce any.
  async _generateWithBackupProviders(prompt, options = {}) {
    const saved = {
      client: this.client,
      model: this.model,
      providerName: this.providerName,
      gemini: this.gemini,
      agentRouter: this.agentRouter
    };

    try {
      for (const [id, preset] of Object.entries(PROVIDERS)) {
        const key = process.env[preset.envKey];
        if (!key || preset.name === saved.providerName) {
          continue;
        }

        // _generateTextPrimary dispatches on these, so they must be cleared or
        // the backup client is never reached.
        this.gemini = null;
        this.agentRouter = null;
        this._initOpenAICompatible(preset, key);

        try {
          const text = await this._generateTextPrimary(prompt, options);
          this.logger.warn(`Recovered on backup provider ${preset.name} (${id})`);
          return text;
        } catch (backupError) {
          this.logger.warn(`Backup provider ${preset.name} failed (${String(backupError.message).slice(0, 70)})`);
        }
      }
    } finally {
      // The primary stays the primary — a one-off outage must not silently
      // re-point the channel's writer at a weaker model for the rest of the run.
      Object.assign(this, saved);
    }

    return null;
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
    const requested = options.maxTokens || 2048;
    // A request too big for the default model's cap switches models instead
    // of getting clamped — clamping silently truncated a full script mid-JSON
    // rather than failing loudly. See the groq preset's largeModel comment.
    const overCap = this.maxOutputTokens && requested > this.maxOutputTokens;
    const model = options.model || (overCap && this.largeModel ? this.largeModel : this.model);
    const maxTokens = overCap && !this.largeModel ? this.maxOutputTokens : requested;
    const temperature = options.temperature ?? 0.7;

    if (this.agentRouter) {
      // The router exposes no temperature or token controls; the agent decides.
      return await this._generateAgentRouterText(prompt);
    }

    if (this.gemini) {
      // gemini-3.5-flash reasons before it answers, and `response.text`
      // concatenates the reasoning with the answer: asked for documentary
      // narration it came back "thought\nLet me recount carefully. MS Word
      // style word count..." as though that were the script. Turning the
      // thinking budget off is the fix; filtering parts marked `thought`
      // covers a model that reasons anyway despite being asked not to.
      const response = await this.gemini.models.generateContent({
        model,
        contents: prompt,
        config: {
          maxOutputTokens: maxTokens,
          temperature,
          thinkingConfig: { thinkingBudget: 0 }
        },
      });

      const parts = response.candidates?.[0]?.content?.parts || [];
      const answer = parts.filter(p => !p.thought && p.text).map(p => p.text).join('').trim();
      if (answer) return answer;

      // Nothing usable in the parts — fall back to .text rather than returning
      // empty, but never hand back something that is only thinking out loud.
      const raw = String(response.text || '').trim();
      if (/^thought\b/i.test(raw)) throw new Error('Gemini returned reasoning instead of an answer');
      return raw;
    }

    if (!this.client) {
      throw new Error('No AI text provider configured');
    }

    // Llama-class models emit invalid JSON often enough to matter (unescaped
    // quotes, trailing commas) — especially in French, where apostrophes are
    // everywhere. Native JSON mode makes valid output a guarantee instead of a
    // hope, so the callers stop falling back to templates.
    const wantsJson = options.json ?? /only valid JSON/i.test(prompt);

    // Logged BEFORE the call, not after. Every other log line on this path
    // fires on success, so a hung request produced total silence and looked
    // identical to a dead process. A long script is minutes of legitimate
    // waiting; the operator needs to see that it started.
    const startedAt = Date.now();
    this.logger.info(`${this.providerName} generating (model: ${model}, max_tokens: ${maxTokens})`);

    // gpt-oss models reason before answering and the reasoning counts against
    // max_tokens: a 900-token segment request came back as 0 words of prose
    // (2026-10-06). Keep their reasoning short and give it headroom on top.
    const reasoning = /gpt-oss/i.test(model);
    const response = await this.client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: reasoning ? maxTokens + 3000 : maxTokens,
      temperature,
      ...(reasoning ? { reasoning_effort: 'low' } : {}),
      ...(wantsJson ? { response_format: { type: 'json_object' } } : {})
    });

    this.logger.info(`${this.providerName} responded in ${Math.round((Date.now() - startedAt) / 1000)}s`);
    const content = response.choices[0].message.content;
    // An empty answer is a failure, not a result: thrown, it reaches the
    // fallback providers; returned, it became a 0-word segment.
    if (!String(content || '').trim()) throw new Error(`${this.providerName} returned an empty completion`);
    return content;
  }

  isAvailable() {
    return !!(this.client || this.gemini || this.agentRouter);
  }
}

module.exports = { AITextService, PROVIDERS };
