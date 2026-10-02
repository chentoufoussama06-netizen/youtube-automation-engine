// Push a channel's live numbers into the WHOP OS dashboard.
//
// WHOP OS (../../WHOP OS) is the front end over these channels; this repo is the
// engine that actually makes and publishes the videos. Until now the dashboard
// only learned a channel's numbers when somebody opened it and pressed refresh,
// so its "history" recorded when a human happened to look rather than what the
// channel did.
//
// This writes straight to the same Postgres the dashboard reads. Posting to its
// HTTP API would have been tidier, but that API only exists while `next dev` is
// running on this machine — which is almost never. The database is hosted, so a
// snapshot taken right after an upload lands whether or not anyone is watching.
//
// Nothing here may fail an upload. A dashboard missing a data point is a small
// problem; a video that did not publish because the dashboard's database was
// unreachable is a real one. Every failure is caught and logged, never thrown.

const { Logger } = require('./logger');

const logger = new Logger('WhopOS');

/**
 * @param {object} channel   { channelId, title, handle, thumbnailUrl,
 *                             subscriberCount, viewCount, videoCount }
 * @returns {Promise<boolean>} true when a snapshot was written
 */
async function pushChannelSnapshot(channel) {
  const url = process.env.WHOP_OS_DATABASE_URL;
  if (!url) return false;                  // dashboard not configured — skip quietly
  if (!channel?.channelId) return false;

  let sql;
  try {
    // Required lazily so the engine still runs where this optional dependency
    // was never installed.
    const postgres = require('postgres');
    sql = postgres(url, { ssl: 'require', max: 1, connect_timeout: 15 });

    await sql`
      insert into youtube_channels (channel_id, title, handle, thumbnail_url)
      values (${channel.channelId}, ${channel.title || channel.channelId},
              ${channel.handle || null}, ${channel.thumbnailUrl || null})
      on conflict (channel_id) do update
        set title = excluded.title,
            handle = excluded.handle,
            thumbnail_url = excluded.thumbnail_url
    `;

    await sql`
      insert into channel_snapshots (channel_id, subscriber_count, view_count, video_count)
      values (${channel.channelId}, ${channel.subscriberCount ?? null},
              ${channel.viewCount ?? null}, ${channel.videoCount ?? null})
    `;

    logger.info(`${channel.title}: ${channel.subscriberCount} subs, `
      + `${channel.viewCount} views, ${channel.videoCount} videos -> WHOP OS`);
    return true;
  } catch (error) {
    logger.warn(`snapshot not recorded (${String(error.message).slice(0, 90)})`);
    return false;
  } finally {
    if (sql) await sql.end({ timeout: 5 }).catch(() => {});
  }
}

/** Read the authorized channel's current numbers through an existing client. */
async function readChannel(youtube) {
  const res = await youtube.channels.list({ part: 'snippet,statistics', mine: true });
  const c = res.data.items?.[0];
  if (!c) throw new Error('no channel on this credential');

  return {
    channelId: c.id,
    title: c.snippet.title,
    handle: c.snippet.customUrl || null,
    thumbnailUrl: c.snippet.thumbnails?.default?.url || null,
    // hiddenSubscriberCount means the channel hides the figure; storing the 0
    // YouTube returns in that case would be a lie the dashboard then charts.
    subscriberCount: c.statistics.hiddenSubscriberCount ? null : Number(c.statistics.subscriberCount ?? 0),
    viewCount: Number(c.statistics.viewCount ?? 0),
    videoCount: Number(c.statistics.videoCount ?? 0)
  };
}

/** Read the authorized channel and record it, in one call. */
async function recordCurrentChannel(youtube) {
  try {
    return await pushChannelSnapshot(await readChannel(youtube));
  } catch (error) {
    logger.warn(`snapshot skipped (${String(error.message).slice(0, 80)})`);
    return false;
  }
}

/**
 * Pull performance metrics and record them for the dashboard.
 *
 * These come from the YouTube ANALYTICS API, not the Data API, and that
 * distinction is the whole reason this lives in the engine. Watch time, average
 * view duration and subscriber conversion are private to the channel owner, so
 * an API key cannot read them at any price — only an OAuth credential for that
 * exact channel can. WHOP OS has the key; this repo has the credential.
 *
 * Read-only against YouTube. Failure is logged, never thrown.
 */
async function pushChannelAnalytics(auth, channelId, { days = 28, topVideos = 15 } = {}) {
  const url = process.env.WHOP_OS_DATABASE_URL;
  if (!url) return false;

  const { google } = require('googleapis');
  const analytics = google.youtubeAnalytics({ version: 'v2', auth });
  const asDate = (d) => d.toISOString().slice(0, 10);
  const startDate = asDate(new Date(Date.now() - days * 86400000));
  const endDate = asDate(new Date());

  let sql;
  try {
    const postgres = require('postgres');
    sql = postgres(url, { ssl: 'require', max: 1, connect_timeout: 15 });

    // ---- channel totals ----
    const totals = await analytics.reports.query({
      ids: 'channel==MINE', startDate, endDate,
      metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,'
        + 'subscribersGained,subscribersLost,likes,comments,shares'
    });
    const t = totals.data.rows?.[0] || [];
    await sql`
      insert into channel_analytics (channel_id, period_days, views, watch_minutes,
        avg_view_duration, avg_view_percentage, subscribers_gained, subscribers_lost,
        likes, comments, shares)
      values (${channelId}, ${days}, ${t[0] ?? null}, ${t[1] ?? null}, ${t[2] ?? null},
              ${t[3] ?? null}, ${t[4] ?? null}, ${t[5] ?? null}, ${t[6] ?? null},
              ${t[7] ?? null}, ${t[8] ?? null})
    `;

    // ---- traffic sources ----
    const sources = await analytics.reports.query({
      ids: 'channel==MINE', startDate, endDate,
      metrics: 'views,estimatedMinutesWatched',
      dimensions: 'insightTrafficSourceType', sort: '-views'
    }).catch(() => ({ data: { rows: [] } }));
    for (const [source, views, minutes] of sources.data.rows || []) {
      await sql`
        insert into traffic_sources (channel_id, period_days, source, views, watch_minutes)
        values (${channelId}, ${days}, ${source}, ${views ?? null}, ${Math.round(minutes ?? 0)})
      `;
    }

    // ---- per-video ----
    const perVideo = await analytics.reports.query({
      ids: 'channel==MINE', startDate, endDate,
      metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained',
      dimensions: 'video', sort: '-views', maxResults: topVideos
    }).catch(() => ({ data: { rows: [] } }));

    const rows = perVideo.data.rows || [];
    if (rows.length) {
      // One titles lookup for the whole set rather than one per row.
      const yt = google.youtube({ version: 'v3', auth });
      const meta = await yt.videos.list({ part: 'snippet', id: rows.map((r) => r[0]).join(',') })
        .catch(() => ({ data: { items: [] } }));
      const titleOf = new Map((meta.data.items || []).map((v) => [v.id, v.snippet.title]));

      for (const [videoId, views, minutes, avgDur, avgPct, gained] of rows) {
        await sql`
          insert into video_analytics (channel_id, video_id, title, period_days, views,
            watch_minutes, avg_view_duration, avg_view_percentage, subscribers_gained)
          values (${channelId}, ${videoId}, ${titleOf.get(videoId) ?? null}, ${days},
                  ${views ?? null}, ${Math.round(minutes ?? 0)}, ${avgDur ?? null},
                  ${avgPct ?? null}, ${gained ?? null})
        `;
      }
    }

    logger.info(`analytics ${days}d: ${t[0] ?? 0} views, ${Math.round(t[1] ?? 0)} min watched, `
      + `+${t[4] ?? 0} subs, ${rows.length} video row(s) -> WHOP OS`);
    return true;
  } catch (error) {
    logger.warn(`analytics not recorded (${String(error.message).slice(0, 90)})`);
    return false;
  } finally {
    if (sql) await sql.end({ timeout: 5 }).catch(() => {});
  }
}

/**
 * Put every video a channel has published into the dashboard's tracker.
 *
 * WHOP OS's Clips page exists to watch individual videos and estimate payout
 * from a $/1k rate, but nothing ever filled it — an empty form sitting beside
 * 48 published videos. The upload ledgers already list every one, so this reads
 * their live counts and files them.
 *
 * `label` carries the channel name so one list stays readable across three
 * channels, and the ledger's own id becomes the campaign field, which is what
 * ties a row back to the clip or documentary that produced it.
 *
 * Entries flagged `missingOnYouTube` are skipped: a video that no longer exists
 * has no statistics, and re-adding it every sync would quietly refill the page
 * with rows that can never update.
 */
async function pushTrackedVideos(auth, ledger, channelTitle) {
  const url = process.env.WHOP_OS_DATABASE_URL;
  if (!url) return 0;

  const { google } = require('googleapis');
  const yt = google.youtube({ version: 'v3', auth });
  const entries = Object.entries(ledger).filter(([, v]) => v.videoId && !v.missingOnYouTube);
  if (!entries.length) return 0;

  let sql;
  try {
    const postgres = require('postgres');
    sql = postgres(url, { ssl: 'require', max: 1, connect_timeout: 15 });
    let stored = 0;

    // videos.list takes 50 ids per call and costs one unit either way.
    for (let i = 0; i < entries.length; i += 50) {
      const batch = entries.slice(i, i + 50);
      const res = await yt.videos.list({
        part: 'snippet,statistics',
        id: batch.map(([, v]) => v.videoId).join(',')
      });

      const byId = new Map((res.data.items || []).map((v) => [v.id, v]));
      for (const [id, entry] of batch) {
        const v = byId.get(entry.videoId);
        if (!v) continue;

        await sql`
          insert into tracked_videos (video_id, title, channel_title, thumbnail_url, url, label, campaign)
          values (${v.id}, ${v.snippet.title}, ${channelTitle},
                  ${v.snippet.thumbnails?.default?.url || null},
                  ${entry.url || `https://www.youtube.com/watch?v=${v.id}`},
                  ${channelTitle}, ${id})
          on conflict (video_id) do update
            set title = excluded.title, channel_title = excluded.channel_title
        `;
        await sql`
          insert into video_snapshots (video_id, view_count, like_count, comment_count)
          values (${v.id}, ${Number(v.statistics.viewCount ?? 0)},
                  ${Number(v.statistics.likeCount ?? 0)},
                  ${Number(v.statistics.commentCount ?? 0)})
        `;
        stored++;
      }
    }

    logger.info(`${channelTitle}: ${stored} video(s) tracked -> WHOP OS`);
    return stored;
  } catch (error) {
    logger.warn(`video tracking skipped (${String(error.message).slice(0, 90)})`);
    return 0;
  } finally {
    if (sql) await sql.end({ timeout: 5 }).catch(() => {});
  }
}

module.exports = {
  pushChannelSnapshot, readChannel, recordCurrentChannel,
  pushChannelAnalytics, pushTrackedVideos
};
