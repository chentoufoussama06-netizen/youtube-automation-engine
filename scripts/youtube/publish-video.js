#!/usr/bin/env node
// Flip a YouTube video's privacyStatus to public (long-form equivalent of
// `upload-shorts.js --publish`, which only tracks shorts).
//   node scripts/publish-video.js <videoId>
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const ROOT = path.join(__dirname, '..', '..');

function authorize() {
  const creds = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'credentials.json'), 'utf8')).youtube;
  const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'tokens.json'), 'utf8')).youtube;
  const oauth = new google.auth.OAuth2(creds.client_id, creds.client_secret, (creds.redirect_uris || [])[0]);
  oauth.setCredentials(tokens);
  return google.youtube({ version: 'v3', auth: oauth });
}

async function main() {
  const [videoId] = process.argv.slice(2);
  if (!videoId) throw new Error('usage: publish-video-oneoff.js <videoId>');
  const youtube = authorize();
  await youtube.videos.update({
    part: 'status',
    requestBody: { id: videoId, status: { privacyStatus: 'public', selfDeclaredMadeForKids: false } }
  });
  console.log(`${videoId} is PUBLIC -> https://www.youtube.com/watch?v=${videoId}`);
}

main().catch(e => { console.error('failed:', e.message); process.exit(1); });
