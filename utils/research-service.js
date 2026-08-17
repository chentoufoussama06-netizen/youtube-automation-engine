/* global fetch, AbortSignal, URLSearchParams */
// fetch and AbortSignal are Node globals from v18 onward; package.json already
// pins engines.node to >=18. Declared here because the shared eslint config
// predates them.
const { Logger } = require('./logger');

// Grounds scripts in sourced facts instead of model memory.
//
// A language model asked to narrate a real event reconstructs it from training
// data, and the failure mode is not "I don't know" — it is a fluent, confident
// wrong answer. Measured on the Emiliano Sala crash: Groq invented an RAF career
// for the pilot and blamed technical failure; Cerebras reversed the direction of
// the flight and aged the victim by seven years. For a channel narrating real
// deaths, that is the whole product broken.
//
// Wikipedia is used because it is free, keyless, has strong French coverage of
// exactly this material, and cites its sources. It is a starting point, not an
// authority: the brief is passed to the writer as the ONLY permitted source of
// names, dates and figures.
class ResearchService {
  constructor() {
    this.logger = new Logger('ResearchService');
    this.lang = process.env.RESEARCH_WIKI_LANG || process.env.CONTENT_LANGUAGE || 'fr';
  }

  get apiUrl() {
    return `https://${this.lang}.wikipedia.org/w/api.php`;
  }

  async _api(params) {
    const url = `${this.apiUrl}?${new URLSearchParams({ format: 'json', ...params })}`;
    const res = await fetch(url, {
      // Wikipedia blocks requests without a descriptive User-Agent.
      headers: { 'User-Agent': 'youtube-automation-agent/1.0 (documentary research)' },
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
    return res.json();
  }

  // Wikipedia's search tolerates loose phrasing far better than exact title
  // lookup, which fails on anything but the canonical article name.
  async findArticle(topic) {
    const data = await this._api({ action: 'query', list: 'search', srsearch: topic, srlimit: 5 });
    const hits = data?.query?.search || [];
    return hits.length ? hits[0].title : null;
  }

  async fetchExtract(title) {
    const data = await this._api({
      action: 'query',
      prop: 'extracts',
      explaintext: '1',
      exsectionformat: 'plain',
      titles: title,
      redirects: '1'
    });
    const pages = data?.query?.pages || {};
    const page = Object.values(pages)[0];
    if (!page || page.missing !== undefined) return null;
    return { title: page.title, extract: page.extract || '' };
  }

  // Returns a plain-text brief for the prompt, or null when nothing usable was
  // found. Callers must treat null as "write without sourced specifics" rather
  // than failing the run — a script with fewer hard numbers beats a wrong one.
  async buildBrief(topic, { maxChars = 6000 } = {}) {
    try {
      const title = await this.findArticle(topic);
      if (!title) {
        this.logger.warn(`No ${this.lang}.wikipedia article found for "${topic}"`);
        return null;
      }

      const article = await this.fetchExtract(title);
      if (!article || !article.extract.trim()) {
        this.logger.warn(`Article "${title}" had no extractable text`);
        return null;
      }

      // Trim on a paragraph boundary so the brief never ends mid-sentence, which
      // reads to the model as a truncated fact it may then "complete".
      let text = article.extract.trim();
      if (text.length > maxChars) {
        const cut = text.lastIndexOf('\n\n', maxChars);
        text = text.slice(0, cut > maxChars * 0.5 ? cut : maxChars).trim();
      }

      const url = `https://${this.lang}.wikipedia.org/wiki/${encodeURIComponent(article.title.replace(/ /g, '_'))}`;
      this.logger.info(`Research brief: "${article.title}" (${text.length} chars)`);
      return { title: article.title, url, text };
    } catch (error) {
      this.logger.warn(`Research failed for "${topic}": ${error.message}`);
      return null;
    }
  }
}

module.exports = { ResearchService };
