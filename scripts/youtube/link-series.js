#!/usr/bin/env node
/**
 * Chain one part of a story-short series to the next, and keep the whole
 * series in one playlist.
 *
 *   node scripts/youtube/link-series.js <prevVideoId> <nextVideoId> <part> --playlist-title "John Terry: the full story"
 *   node scripts/youtube/link-series.js <prevVideoId> <nextVideoId> <part> --playlist <playlistId>
 *   ... --dry-run     # read and report, change nothing
 *
 * The previous part's description gets "▶ Part N: <link>" as its first line,
 * which is where a viewer who just finished it looks. The Data API cannot set a
 * Short's "related video" link (that is Studio only), so the description and
 * the playlist are what automation can do.
 *
 * Idempotent: a link or playlist item already there is not added twice, so a
 * run that died half-way (quota) is simply repeated. Prints
 * SERIES_PLAYLIST=<id> as soon as the playlist exists, for the caller to keep.
 *
 * Quota: ~200 units to start a series (list 1, playlist 50, two items 100,
 * description 50), ~100 for each later part. Uses YT_TOKENS_FILE like
 * upload-shorts.js, so it acts on the lane's own channel.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { Logger } = require('../../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const YT_TOKENS_FILE = process.env.YT_TOKENS_FILE || 'tokens.json';
const logger = new Logger('LinkSeries');

const shortUrl = (id) => `https://youtube.com/shorts/${id}`;

function authorize() {
  const creds = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'credentials.json'), 'utf8')).youtube;
  const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', YT_TOKENS_FILE), 'utf8')).youtube;
  const oauth = new google.auth.OAuth2(creds.client_id, creds.client_secret, (creds.redirect_uris || [])[0]);
  oauth.setCredentials(tokens);
  return google.youtube({ version: 'v3', auth: oauth });
}

async function ensurePlaylist(youtube, playlistId, title, dryRun) {
  if (playlistId) return playlistId;
  if (dryRun) {
    logger.info(`[dry-run] would create playlist "${title}"`);
    return null;
  }
  const { data } = await youtube.playlists.insert({
    part: 'snippet,status',
    requestBody: {
      snippet: { title: title.slice(0, 150), description: 'Every part of the story, in order.' },
      status: { privacyStatus: 'public' }
    }
  });
  logger.success(`created playlist "${title}" (${data.id})`);
  return data.id;
}

// A playlist created a second ago answers "cannot be found" for a little
// while (2026-10-30: both first series died here, right after playlists.insert
// succeeded), so a 404 on a fresh playlist is waited out, not believed.
async function withFreshPlaylistRetry(call) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= 4 || !/cannot be found|playlistNotFound/i.test(String(error.message))) throw error;
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
}

async function addToPlaylist(youtube, playlistId, videoIds, { dryRun, fresh }) {
  // A playlist this run just created is empty by definition; listing it is
  // both wasted quota and the call most likely to hit the not-found window.
  const have = new Set();
  let pageToken;
  while (!fresh) {
    const { data } = await youtube.playlistItems.list({ part: 'snippet', playlistId, maxResults: 50, pageToken });
    for (const item of data.items || []) have.add(item.snippet.resourceId.videoId);
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  for (const videoId of videoIds) {
    if (have.has(videoId)) continue;
    if (dryRun) {
      logger.info(`[dry-run] would add ${videoId} to playlist ${playlistId}`);
      continue;
    }
    await withFreshPlaylistRetry(() => youtube.playlistItems.insert({
      part: 'snippet',
      requestBody: { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } }
    }));
    logger.success(`added ${videoId} to playlist ${playlistId}`);
  }
}

async function addNextLink(youtube, prevId, nextId, part, dryRun) {
  const { data } = await youtube.videos.list({ part: 'snippet', id: prevId });
  const s = data.items?.[0]?.snippet;
  if (!s) throw new Error(`video ${prevId} is not on this channel`);
  if ((s.description || '').includes(shortUrl(nextId))) {
    logger.info(`${prevId} already points at Part ${part}`);
    return;
  }
  const line = `▶ Part ${part}: ${shortUrl(nextId)}`;
  if (dryRun) {
    logger.info(`[dry-run] would open ${prevId}'s description with "${line}"`);
    return;
  }
  // videos.update replaces the whole snippet: leaving out tags or a language
  // would wipe them, so everything the upload set is sent back unchanged.
  const snippet = { title: s.title, categoryId: s.categoryId, description: `${line}\n\n${s.description || ''}`.slice(0, 5000) };
  for (const k of ['tags', 'defaultLanguage', 'defaultAudioLanguage']) if (s[k]) snippet[k] = s[k];
  await youtube.videos.update({ part: 'snippet', requestBody: { id: prevId, snippet } });
  logger.success(`${prevId} now points at Part ${part}`);
}

async function main() {
  const args = process.argv.slice(2);
  const valueFlags = ['--playlist', '--playlist-title'];
  const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
  const [prevId, nextId, partArg] = args.filter((a, i) => !a.startsWith('--') && !valueFlags.includes(args[i - 1]));
  const part = Number(partArg);
  if (!prevId || !nextId || !(part >= 2)) {
    throw new Error('usage: link-series.js <prevVideoId> <nextVideoId> <part> [--playlist <id> | --playlist-title "<title>"] [--dry-run]');
  }
  const dryRun = args.includes('--dry-run');
  const youtube = authorize();

  // The description link first: it is what a viewer finishing Part 1 sees, so
  // nothing about the playlist may stand in its way.
  await addNextLink(youtube, prevId, nextId, part, dryRun);

  // The id is printed the moment the playlist exists, so a retry after a
  // later failure reuses it instead of making a second one.
  const given = flag('--playlist');
  const playlistId = await ensurePlaylist(youtube, given, flag('--playlist-title') || 'The full story', dryRun);
  if (playlistId) {
    console.log(`SERIES_PLAYLIST=${playlistId}`);
    await addToPlaylist(youtube, playlistId, [prevId, nextId], { dryRun, fresh: !given });
  }
}

if (require.main === module) {
  main().catch((error) => {
    logger.error(`link-series failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { main };
