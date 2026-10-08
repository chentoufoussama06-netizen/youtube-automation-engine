/**
 * Connect one more YouTube channel: opens Google's consent page, catches the
 * redirect on localhost:8420 and writes config/<file> in the same shape as
 * tokens.json. Pick the channel on Google's account chooser.
 *
 *   node scripts/youtube/connect-channel.js tokens.channel4.json
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { exec } = require('child_process');
const { google } = require('googleapis');

const file = process.argv[2];
if (!file || !/^tokens\.[\w-]+\.json$/.test(file)) {
  console.error('Usage: node scripts/youtube/connect-channel.js tokens.<name>.json');
  process.exit(1);
}
const config = path.join(__dirname, '..', '..', 'config');
const creds = JSON.parse(fs.readFileSync(path.join(config, 'credentials.json'), 'utf8')).youtube;
const redirect = creds.redirect_uris[0];
const auth = new google.auth.OAuth2(creds.client_id, creds.client_secret, redirect);
const url = auth.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent select_account',
  scope: [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube',
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/yt-analytics.readonly'
  ]
});

const { port, pathname } = new URL(redirect);
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, redirect);
  if (u.pathname !== pathname) { res.end(); return; }
  const code = u.searchParams.get('code');
  if (!code) { res.end(`No code: ${u.searchParams.get('error')}`); return; }
  try {
    const { tokens } = await auth.getToken(code);
    auth.setCredentials(tokens);
    const ch = (await google.youtube({ version: 'v3', auth }).channels.list({ part: 'snippet,statistics', mine: true })).data.items?.[0];
    fs.writeFileSync(path.join(config, file), JSON.stringify({ youtube: tokens }, null, 2));
    const who = ch ? `${ch.snippet.title} (${ch.statistics.subscriberCount} subs, ${ch.statistics.videoCount} videos, ${ch.id})` : 'NO CHANNEL on this login';
    console.log(`Saved config/${file} -> ${who}`);
    res.end(`Connected: ${who}. You can close this tab.`);
  } catch (e) {
    console.error(e.message);
    res.end(`Failed: ${e.message}`);
  }
  server.close();
});
server.listen(+port, () => {
  console.log(`Open this if the browser did not:\n${url}`);
  exec(`start "" "${url}"`);
});
