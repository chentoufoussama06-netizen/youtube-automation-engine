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
// Narrative scaffolding a French title wraps around its subject. These words
// carry no information about WHICH person or event is meant, so matching on
// them would let any article about a death or a disaster look like a hit.
const TOPIC_STOPWORDS = new Set([
  'le', 'la', 'les', 'l', 'un', 'une', 'de', 'des', 'du', 'd', 'et', 'en',
  'a', 'au', 'aux', 'the', 'of',
  'affaire', 'aerienne', 'annee', 'annees', 'arret', 'catastrophe', 'chute',
  'dernier', 'derniere', 'derniers', 'dernieres', 'disparition', 'drame',
  'jours', 'meurtre', 'mort', 'paris', 'silence', 'titularisation',
  'tragedie', 'victimes', 'vol'
]);

// How much of the extract counts as the lead. Wikipedia's opening paragraph
// defines the subject; past that the article drifts into related people.
const LEAD_CHARS = 600;

// Accents differ between the topic string and the article title ("Foe" vs
// "Foé", "Andres" vs "Andrés"), so compare with them stripped.
function foldAccents(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function topicTerms(topic) {
  return foldAccents(topic)
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 1 && !TOPIC_STOPWORDS.has(word));
}

function termRatio(terms, title) {
  const folded = foldAccents(title);
  const found = terms.filter(term => folded.includes(term));
  return terms.length ? found.length / terms.length : 0;
}

class ResearchService {
  constructor() {
    this.logger = new Logger('ResearchService');
    this.lang = process.env.RESEARCH_WIKI_LANG || process.env.CONTENT_LANGUAGE || 'fr';
  }

  get apiUrl() {
    return `https://${this.lang}.wikipedia.org/w/api.php`;
  }

  /**
   * One Wikipedia API call, paced and retried.
   *
   * Without pacing this hammers the API and gets back "You are making too many
   * requests to the API" — which arrives as a 200 with an HTML-ish body, so it
   * does not throw, it just fails to parse or yields no results. The visible
   * symptom is every article lookup reporting "no match", which reads exactly
   * like the search being wrong. A whole compilation was written from the
   * wrong sources chasing that false trail.
   *
   * Calls are therefore serialised through a single chain with a minimum gap,
   * and a rate-limit response is waited out rather than treated as an answer.
   */
  async _api(params, attempt = 1) {
    const gap = Number(process.env.RESEARCH_API_GAP_MS) || 1100;
    const wait = Math.max(0, (ResearchService._nextAt || 0) - Date.now());
    ResearchService._nextAt = Date.now() + wait + gap;
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));

    const url = `${this.apiUrl}?${new URLSearchParams({ format: 'json', ...params })}`;
    const res = await fetch(url, {
      // Wikipedia blocks requests without a descriptive User-Agent.
      headers: { 'User-Agent': 'youtube-automation-agent/1.0 (documentary research)' },
      signal: AbortSignal.timeout(30000)
    });

    const body = await res.text();
    const rateLimited = res.status === 429 || /too many requests/i.test(body.slice(0, 200));

    if (rateLimited) {
      if (attempt >= 4) throw new Error('Wikipedia rate limit — gave up after 4 attempts');
      const backoff = 2000 * attempt * attempt;
      this.logger.warn(`Wikipedia rate limit; waiting ${(backoff / 1000).toFixed(0)}s (attempt ${attempt})`);
      await new Promise(resolve => setTimeout(resolve, backoff));
      return this._api(params, attempt + 1);
    }

    if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
    try {
      return JSON.parse(body);
    } catch {
      throw new Error(`Wikipedia returned non-JSON: ${body.slice(0, 80)}`);
    }
  }

  // Wikipedia's search tolerates loose phrasing far better than exact title
  // lookup, which fails on anything but the canonical article name. What it
  // does NOT do is guarantee the top hit is the subject you asked about:
  // searching "Le meurtre d'Andres Escobar" ranks Pablo Escobar first, and
  // "Le silence de Robert Enke" returns the economist Vilfredo Pareto. Taking
  // hits[0] on faith fed those biographies into the prompt as sourced fact.
  //
  // So the candidate has to earn it. Every distinctive word in the topic must
  // appear in the article title, or failing that in its lead paragraph - the
  // lead is where an article states what it is about, whereas a body-wide
  // match accepts any passing mention (Thuram's page names Calciopoli).
  // Nothing clears the bar, nothing is returned: buildBrief treats null as
  // "write without sourced specifics", which beats writing from the wrong life.
  async findArticle(topic) {
    const wanted = topicTerms(topic);
    const data = await this._api({ action: 'query', list: 'search', srsearch: topic, srlimit: 5 });
    const hits = data?.query?.search || [];
    if (!hits.length) return null;
    if (!wanted.length) return hits[0].title;

    const ranked = hits
      .map(hit => ({ title: hit.title, score: termRatio(wanted, hit.title) }))
      .sort((a, b) => b.score - a.score);

    if (ranked[0].score === 1) return ranked[0].title;

    // Check every candidate, not only the best-ranked one.
    //
    // Stopping at the top hit rejected articles that were right there in the
    // results. Searching "Ibrox disaster" ranks "Ibrox Stadium" first on title
    // overlap; its lead never says "disaster", so the whole search returned
    // null — and the caller then fell back to the bare venue name and wrote a
    // stadium's history as though it were the story of the crush that happened
    // there. The actual "Ibrox disaster" article was the second hit.
    for (const candidate of ranked) {
      const article = await this.fetchExtract(candidate.title);
      const lead = foldAccents((article?.extract || '').slice(0, LEAD_CHARS));
      if (wanted.every(term => lead.includes(term))) return candidate.title;
    }

    this.logger.warn(
      `No ${this.lang}.wikipedia article matched "${topic}" ` +
      `(closest: "${ranked[0].title}"); writing without sourced specifics`
    );
    return null;
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
  /**
   * A brief from a KNOWN article, with no search step at all.
   *
   * Once a topic carries a pinned QID the article is not a guess — it is the
   * enwiki sitelink of that entity. Searching again can only lose: it is how
   * "Calciopoli" produced a brief about Diego Della Valle, "Port Said stadium
   * disaster" produced the city, and the Ibrox topic produced a stadium with no
   * crush in it to write from. The pin names the article; this fetches it.
   */
  async buildBriefFromArticle(articleTitle, { maxChars = 6000 } = {}) {
    const article = await this.fetchExtract(articleTitle);
    if (!article || !article.extract.trim()) {
      this.logger.warn(`Article "${articleTitle}" had no extractable text`);
      return null;
    }

    let text = article.extract.trim();
    if (text.length > maxChars) {
      const cut = text.lastIndexOf('\n\n', maxChars);
      text = text.slice(0, cut > maxChars * 0.5 ? cut : maxChars).trim();
    }

    const url = `https://${this.lang}.wikipedia.org/wiki/${encodeURIComponent(article.title.replace(/ /g, '_'))}`;
    this.logger.info(`Brief from pinned article: "${article.title}" (${text.length} chars)`);
    return { title: article.title, url, text };
  }

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
