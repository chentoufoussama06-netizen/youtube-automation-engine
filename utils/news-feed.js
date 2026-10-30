/**
 * Football news headlines from Google News' public RSS search: free, no key,
 * no account. Each item names its outlet, so a claim can be traced and
 * attributed instead of repeated as fact.
 *
 * Why Google News and not the reporters' own feeds: X has no free API and its
 * mirrors are gone, and a reporter's own YouTube feed carries a dozen titles a
 * week. The outlets that write up every "here we go" carry the claim, the
 * player and the date — and the same story across several outlets is itself a
 * cross-check. Never fatal: [] on any failure.
 */

const axios = require('axios');

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
const decode = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => ENTITIES[m])
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const tag = (block, name) => (block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)) || [])[1] || '';

/**
 * Headlines matching `query` from the last `days` days, newest first, one per
 * distinct headline. Each: { title, outlet, url, date, snippet }.
 */
async function newsSearch(query, { days = 7, limit = 60, lang = 'en-GB', region = 'GB' } = {}) {
  const q = encodeURIComponent(`${query} when:${days}d`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=${lang}&gl=${region}&ceid=${region}:${lang.split('-')[0]}`;
  try {
    const { data } = await axios.get(url, {
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (youtube-automation-engine news check)' }
    });
    const seen = new Set();
    const items = [];
    for (const block of String(data).split('<item>').slice(1)) {
      const outlet = decode(tag(block, 'source'));
      // Google appends " - Outlet" to every headline.
      const title = decode(tag(block, 'title')).replace(new RegExp(`\\s+-\\s+${outlet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '');
      const key = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!title || seen.has(key)) continue;
      seen.add(key);
      items.push({
        title,
        outlet,
        url: decode(tag(block, 'link')),
        date: new Date(decode(tag(block, 'pubDate'))).toISOString(),
        snippet: decode(tag(block, 'description')).replace(title, '').replace(outlet, '').trim()
      });
    }
    return items.sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, limit);
  } catch {
    return [];
  }
}

// European club football, not the NFL.
const FOOTBALL_QUERY = 'football ("Premier League" OR "La Liga" OR "Champions League" OR "Serie A" OR Bundesliga OR "Ligue 1" OR FIFA OR UEFA)';

/** The last two days of football headlines. */
const footballNews = (opts = {}) => newsSearch(FOOTBALL_QUERY, { days: 2, limit: 40, ...opts });

module.exports = { newsSearch, footballNews, FOOTBALL_QUERY };
