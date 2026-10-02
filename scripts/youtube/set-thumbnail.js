#!/usr/bin/env node
// Set a custom thumbnail for a given YouTube video ID.
//   node scripts/set-thumbnail.js <videoId> <thumbnailPath>
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
  const [videoId, thumbPath] = process.argv.slice(2);
  if (!videoId || !thumbPath) throw new Error('usage: set-thumbnail-oneoff.js <videoId> <thumbnailPath>');
  const youtube = authorize();
  await youtube.thumbnails.set({
    videoId,
    media: { body: fs.createReadStream(thumbPath) }
  });
  console.log(`thumbnail set for ${videoId}`);
}

main().catch(e => { console.error('failed:', e.message); process.exit(1); });
