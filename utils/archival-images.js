/* global fetch, AbortSignal, URLSearchParams */
// Archival stills from Wikimedia Commons.
//
// The channel's hardest constraint is that no legal archive football footage
// exists for these stories: World Cup matches belong to FIFA, the news photos
// to Getty/AP/AFP/Reuters, the 1958 newsreels to British Pathé. Using any of
// them earns Content ID claims and, three strikes in, ends the channel. So the
// pipeline has only ever had atmospheric Pexels b-roll — generic stadium and
// rain shots that carry no information about the actual story.
//
// Commons is the one large pool of media that is both ABOUT these people and
// legally reusable commercially. This module pulls from it under two rules that
// are easy to get wrong:
//
//   1. Freely downloadable is not freely licensed. Commons hosts non-free files
//      under fair-use style tags, and CC BY-NC / BY-ND forbid exactly what a
//      monetised channel does. Only licenses matching FREE_LICENSE are kept.
//   2. A search hit is not a relevant hit. Querying "Port Said Stadium riot"
//      returns 201 files whose top results are unrelated Egyptian street photos
//      ("The bread is ready for sale.jpg"). Dropping those into a video is
//      worse than stock footage, so every candidate must earn a relevance score
//      against the topic's own keywords before it is accepted.
const fs = require('fs').promises;
const path = require('path');
const { Logger } = require('./logger');

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';

// Commons blocks generic clients and rate-limits hard; a descriptive UA with a
// contact route is what their policy asks for and what keeps 429s away.
const USER_AGENT = 'MarcoDeHierra-Documentary/1.0 (French documentary channel; automated archival sourcing)';

// Licenses that permit commercial reuse. Matched against extmetadata's
// LicenseShortName, which is a display string rather than an identifier, hence
// the tolerant shapes ("CC BY-SA 4.0", "Public domain", "PD-old-70").
const FREE_LICENSE = /^(cc0|cc[ -]by(?:[ -]sa)?(?:[ -]\d(?:\.\d)?)*|public domain|pd(?:[ -]|$)|no restrictions)/i;

// Explicit disqualifiers. NC forbids monetised use and ND forbids the cropping
// and panning this pipeline does, so both are unusable here even though Commons
// files carrying them are perfectly downloadable.
const BLOCKED_LICENSE = /non[ -]?free|fair[ -]use|by[ -]nc|by[ -]nd|all rights reserved/i;

const USABLE_EXTENSION = /\.(jpe?g|png)$/i;

// Combining marks, stripped so "Andrés" matches "Andres" in a filename.
const DIACRITICS = /[̀-ͯ]/g;

function fold(value) {
  return String(value).toLowerCase().normalize('NFD').replace(DIACRITICS, '');
}

class ArchivalImageService {
  constructor(options = {}) {
    this.logger = options.logger || new Logger('ArchivalImages');
    this.minWidth = Number(process.env.ARCHIVAL_MIN_WIDTH) || 600;
    this.requestDelayMs = Number(process.env.ARCHIVAL_DELAY_MS) || 1200;
  }

  async _api(params) {
    const url = `${COMMONS_API}?${new URLSearchParams({ format: 'json', ...params })}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(30000)
    });

    // Commons answers a plain-text scolding rather than JSON when it throttles,
    // which surfaces as an unhelpful "Unexpected token 'Y'" parse error unless
    // the body is checked before parsing.
    const body = await response.text();
    if (!response.ok || !body.trimStart().startsWith('{')) {
      throw new Error(`Commons HTTP ${response.status}: ${body.slice(0, 90).replace(/\s+/g, ' ')}`);
    }
    return JSON.parse(body);
  }

  /**
   * Is this file licensed for commercial reuse?
   * Returns { ok, license, artist, credit } — artist/credit are what the video
   * description must carry for CC BY and CC BY-SA attribution.
   */
  _checkLicense(meta = {}) {
    const strip = value => String(value?.value || '').replace(/<[^>]*>/g, '').trim();

    const license = strip(meta.LicenseShortName) || strip(meta.License);
    const terms = `${license} ${strip(meta.UsageTerms)} ${strip(meta.Restrictions)}`;

    if (!license || BLOCKED_LICENSE.test(terms) || !FREE_LICENSE.test(license)) {
      return { ok: false, license: license || 'unknown' };
    }

    return {
      ok: true,
      license,
      artist: strip(meta.Artist) || 'Unknown',
      credit: strip(meta.Credit) || 'Wikimedia Commons'
    };
  }

  /**
   * How well does a filename match what the episode is actually about?
   * Commons titles are descriptive ("Andrés Escobar Díaz.jpg"), so the title is
   * a far better relevance signal than search rank, which happily returns
   * anything sharing a city name.
   *
   * Scoring is deliberately two-tier. A flat "any keyword matches" rule let
   * "Port said egypt (6).JPG" — a street photo — outrank the actual 2012
   * stadium disaster, because it matched the city. So `must` carries the terms
   * that make a file genuinely about this story (a surname, the event word) and
   * at least one has to appear; `bonus` only breaks ties between files that
   * already qualify.
   */
  _score(title, selectors = {}) {
    const { must = [], bonus = [] } = selectors;
    const haystack = fold(title);
    const hits = needle => needle.length > 2 && haystack.includes(needle);

    if (must.length && !must.some(term => hits(fold(term)))) {
      return 0;
    }

    let score = must.length ? 3 : 0;
    for (const term of bonus) {
      const needle = fold(term);
      if (hits(needle)) {
        score += needle.length > 5 ? 2 : 1;
      }
    }
    return score;
  }

  /**
   * Find archival stills for one search phrase.
   *
   * @param {string} subject     Main search phrase, e.g. "Andrés Escobar"
   * @param {object} selectors   { must: string[], bonus: string[] } — see _score
   * @param {object} opts        { limit }
   * @returns {Promise<Array>} accepted files, best match first
   */
  async fetchArchivalImages(subject, selectors = {}, opts = {}) {
    const limit = opts.limit || 12;

    let data;
    try {
      data = await this._api({
        action: 'query',
        generator: 'search',
        // filetype:bitmap is not just an optimisation. iiurlwidth asks the
        // server to build a thumbnail for every result, and one PDF in the set
        // ("Atividades de Afonso Escobar...pdf") makes MediaWiki fail the WHOLE
        // query with urlparamnormal rather than skip that file — which returned
        // zero images for a subject that has hundreds.
        gsrsearch: `${subject} filetype:bitmap`,
        gsrnamespace: '6',            // File: namespace only
        gsrlimit: String(Math.min(50, limit * 4)),
        prop: 'imageinfo',
        iiprop: 'url|size|extmetadata',
        iiurlwidth: '1920'
      });
    } catch (error) {
      this.logger.warn(`Commons search failed for "${subject}" (${error.message.slice(0, 70)})`);
      return [];
    }

    if (data.error) {
      this.logger.warn(`Commons rejected "${subject}": ${String(data.error.code)} ${String(data.error.info).slice(0, 80)}`);
      return [];
    }

    const pages = Object.values(data.query?.pages || {});
    const accepted = [];
    const rejected = { license: 0, relevance: 0, size: 0, format: 0 };

    for (const page of pages) {
      const info = page.imageinfo?.[0];
      const title = String(page.title || '').replace(/^File:/, '');
      if (!info) continue;

      if (!USABLE_EXTENSION.test(title)) { rejected.format++; continue; }

      const license = this._checkLicense(info.extmetadata);
      if (!license.ok) { rejected.license++; continue; }

      if ((info.width || 0) < this.minWidth) { rejected.size++; continue; }

      const score = this._score(title, selectors);
      if (score < 3) { rejected.relevance++; continue; }

      accepted.push({
        title,
        score,
        width: info.width,
        height: info.height,
        url: info.thumburl || info.url,
        descriptionUrl: info.descriptionurl,
        license: license.license,
        artist: license.artist,
        credit: license.credit
      });
    }

    accepted.sort((a, b) => b.score - a.score || b.width - a.width);
    const chosen = accepted.slice(0, limit);

    this.logger.info(
      `Commons "${subject}": ${chosen.length} usable of ${pages.length} `
      + `(rejected ${rejected.license} license, ${rejected.relevance} irrelevant, `
      + `${rejected.size} too small, ${rejected.format} wrong format)`
    );

    return chosen;
  }

  /**
   * Run several searches for one episode and merge the results, de-duplicated.
   * Topics are richer than a single phrase — the Escobar story wants the man,
   * the club and the city — so one query per angle finds material that a single
   * search misses entirely.
   */
  async gatherForTopic(queries, selectors, opts = {}) {
    const perQuery = opts.perQuery || 8;
    const total = opts.total || 15;
    const seen = new Set();
    const all = [];

    for (const query of queries) {
      const found = await this.fetchArchivalImages(query, selectors, { limit: perQuery });
      for (const item of found) {
        if (seen.has(item.title)) continue;
        seen.add(item.title);
        all.push(item);
      }
      // Space the calls out; Commons throttles bursts aggressively.
      await new Promise(resolve => setTimeout(resolve, this.requestDelayMs));
    }

    all.sort((a, b) => b.score - a.score || b.width - a.width);
    return all.slice(0, total);
  }

  /**
   * Download the chosen files into a cache directory. Each image gets a sidecar
   * .json carrying its licence and author, because CC BY and CC BY-SA are only
   * satisfied if that credit actually reaches the video description — losing it
   * turns a legal image into an infringing one.
   */
  async downloadArchivalImages(images, destDir) {
    await fs.mkdir(destDir, { recursive: true });
    const saved = [];

    for (const image of images) {
      const safe = image.title.replace(/[^a-z0-9.]+/gi, '_').slice(-70);
      const ext = (path.extname(safe) || '.jpg').toLowerCase();
      const filePath = path.join(destDir, safe.replace(/\.[^.]+$/, '') + ext);

      try {
        const existing = await fs.stat(filePath).catch(() => null);
        if (!existing || !existing.size) {
          const response = await fetch(image.url, {
            headers: { 'User-Agent': USER_AGENT },
            signal: AbortSignal.timeout(60000)
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          await fs.writeFile(filePath, Buffer.from(await response.arrayBuffer()));
        }

        await fs.writeFile(`${filePath}.json`, JSON.stringify({
          file: path.basename(filePath),
          title: image.title,
          license: image.license,
          artist: image.artist,
          credit: image.credit,
          descriptionUrl: image.descriptionUrl
        }, null, 2));

        saved.push({ ...image, path: filePath });
      } catch (error) {
        this.logger.warn(`Could not download "${image.title}" (${error.message.slice(0, 60)})`);
      }
    }

    this.logger.info(`Archival images ready: ${saved.length}/${images.length}`);
    return saved;
  }

  /**
   * The attribution block for the video description. Public-domain files need
   * no credit, but listing them costs nothing and makes the sourcing auditable.
   */
  buildAttribution(images) {
    if (!images.length) return '';

    const lines = images.map(image =>
      `- ${image.title} — ${image.artist} (${image.license}) via Wikimedia Commons`
    );

    return ["Images d'archive :", ...lines, '', 'Source : Wikimedia Commons.'].join('\n');
  }
}

module.exports = { ArchivalImageService, FREE_LICENSE, BLOCKED_LICENSE };
