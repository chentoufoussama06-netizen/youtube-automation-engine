// One-off login health check. Read-only: verifies each configured credential
// with its provider's cheapest free endpoint and prints status only — never a key.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const out = [];
const line = (s) => out.push(s);
const mask = (v) => (v ? `${String(v).slice(0, 4)}…${String(v).slice(-4)}` : '(missing)');

async function check(name, fn) {
  try {
    const detail = await fn();
    line(`✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    const msg = e.response ? `HTTP ${e.response.status} ${JSON.stringify(e.response.data).slice(0, 120)}` : e.message;
    line(`❌ ${name} — ${msg}`);
  }
}

(async () => {
  // ---- YouTube OAuth tokens (3 channels) ----
  const { google } = require('googleapis');
  const creds = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'credentials.json'), 'utf8'));
  for (const f of ['tokens.json', 'tokens.clips.json', 'tokens.aftercache.json']) {
    await check(`YouTube OAuth ${f}`, async () => {
      const tokens = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', f), 'utf8')).youtube;
      if (!tokens || !tokens.refresh_token) throw new Error('no refresh_token stored');
      const oauth2 = new google.auth.OAuth2(creds.youtube.client_id, creds.youtube.client_secret);
      oauth2.setCredentials({ refresh_token: tokens.refresh_token });
      const { token } = await oauth2.getAccessToken(); // forces a real refresh
      const yt = google.youtube({ version: 'v3', auth: oauth2 });
      const ch = await yt.channels.list({ part: 'snippet', mine: true });
      const title = ch.data.items?.[0]?.snippet?.title || 'unknown channel';
      return `refresh OK (${mask(token)}), channel: "${title}"`;
    });
  }

  // ---- AI text providers ----
  if (process.env.MISTRAL_API_KEY) await check('Mistral', async () => {
    const r = await axios.get('https://api.mistral.ai/v1/models', { headers: { Authorization: `Bearer ${process.env.MISTRAL_API_KEY}` }, timeout: 15000 });
    return `OK, ${r.data.data.length} models`;
  });
  if (process.env.GROQ_API_KEY) await check('Groq', async () => {
    const r = await axios.get('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, timeout: 15000 });
    return `OK, ${r.data.data.length} models`;
  });
  if (process.env.CEREBRAS_API_KEY) await check('Cerebras', async () => {
    const r = await axios.get('https://api.cerebras.ai/v1/models', { headers: { Authorization: `Bearer ${process.env.CEREBRAS_API_KEY}` }, timeout: 15000 });
    return `OK, ${r.data.data.length} models`;
  });
  if (process.env.GEMINI_API_KEY) await check('Gemini', async () => {
    const r = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`, { timeout: 15000 });
    return `OK, ${r.data.models.length} models`;
  });
  if (process.env.ELEVENLABS_API_KEY) await check('ElevenLabs', async () => {
    const r = await axios.get('https://api.elevenlabs.io/v1/user', { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }, timeout: 15000 });
    return `OK (${r.data.subscription?.tier || 'tier?'})`;
  });
  if (process.env.HUGGINGFACE_API_KEY) await check('HuggingFace', async () => {
    const r = await axios.get('https://huggingface.co/api/whoami-v2', { headers: { Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}` }, timeout: 15000 });
    return `OK (${r.data.type || r.data.auth?.accessToken?.role || 'user'})`;
  });
  if (process.env.PEXELS_API_KEY) await check('Pexels', async () => {
    const r = await axios.get('https://api.pexels.com/videos/search?query=nature&per_page=1', { headers: { Authorization: process.env.PEXELS_API_KEY }, timeout: 15000 });
    return `OK, ${r.data.total_results} results`;
  });
  if (process.env.APIFY_API_TOKEN) await check('Apify', async () => {
    const r = await axios.get(`https://api.apify.com/v2/users/me?token=${process.env.APIFY_API_TOKEN}`, { timeout: 15000 });
    return `OK (${r.data.data.username})`;
  });
  if (process.env.YOUTUBE_RESEARCH_KEY) await check('YouTube Data API key (research)', async () => {
    const r = await axios.get(`https://www.googleapis.com/youtube/v3/i18nLanguages?part=snippet&key=${process.env.YOUTUBE_RESEARCH_KEY}`, { timeout: 15000 });
    return `OK, ${r.data.items.length} languages`;
  });

  // ---- Whop OS postgres ----
  if (process.env.WHOP_OS_DATABASE_URL) await check('Whop OS Postgres', async () => {
    const postgres = require('postgres');
    const sql = postgres(process.env.WHOP_OS_DATABASE_URL, { max: 1, connect_timeout: 8 });
    await sql`SELECT 1`;
    await sql.end();
    return 'connected, SELECT 1 OK';
  });

  // ---- Structural checks ----
  line('');
  line('API_KEY (protects dashboard mutating routes): ' + (process.env.API_KEY ? 'SET' : '*** EMPTY — /generate and /publish are unauthenticated ***'));
  line('config/credentials.json: ' + (fs.existsSync(path.join(__dirname, '..', '..', 'config', 'credentials.json')) ? 'present' : 'MISSING'));

  console.log(out.join('\n'));
})().catch(e => { console.error('healthcheck crashed:', e.message); process.exit(1); });
