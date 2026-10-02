/**
 * LANE SCHEMA v3 — the channel's editorial lane, as a quota rather than a vibe.
 *
 * The lane is "deaths, disasters and scandals in sport", with football as the
 * centre of gravity. Two lanes:
 *
 *   football     the default, uncapped
 *   sport_wide   everything else in sport — capped at 1 in every 5 uploads
 *
 * WHY A SCHEMA AND NOT A JUDGEMENT CALL. The previous rule inferred the channel
 * from whatever the topic happened to be pinned to, and produced an artifact:
 * Hank Gathers passed as "sport" because his entity is a person carrying
 * P106 basketball player, while Kobe Bryant was cut because his best candidate
 * was a crash event carrying no sport property at all. Same sport, opposite
 * outcomes, decided by the kind of thing that got pinned rather than by any
 * editorial position. A field settles it once.
 *
 * THE CAP IS NOT A PREFERENCE. It is an experiment with a stopping rule: at
 * roughly 30 uploads, if sport_wide beats football on views AND holds at least
 * 45% average retention, the lane widens or flips. If it does not, the lane is
 * cut. Until then the data is being gathered, not argued about.
 */

const LANES = ['football', 'sport_wide'];
const DEFAULT_LANE = 'football';

/** At most one sport_wide upload in any window of this many uploads. */
const SPORT_WIDE_WINDOW = 5;

/** The review threshold, and the bar sport_wide has to clear to survive it. */
const REVIEW_AT_UPLOADS = 30;
const RETENTION_BAR = 0.45;

/** Statuses that take a topic out of the build queue without deleting it. */
const NOT_BUILDABLE = new Set(['short', 'cut', 'parked']);

/**
 * Is this queue row something the engine may build?
 *
 * `short` rows are upload bookkeeping. `cut` and `parked` rows are decisions —
 * parked ones are kept deliberately, against a channel that does not exist yet,
 * so they must never be deleted and never be built.
 */
function isBuildable(topic) {
  return !NOT_BUILDABLE.has(topic?.status);
}

/** A topic's lane, defaulting to football when nothing has been decided. */
function laneOf(topic) {
  const lane = topic?.lane;
  return LANES.includes(lane) ? lane : DEFAULT_LANE;
}

/**
 * May this lane publish next, given the lanes of recent uploads?
 *
 * `recentLanes` is newest-first. football is always allowed. sport_wide is
 * allowed only when the previous four uploads contain none, because publishing
 * it otherwise would put two inside one window of five.
 */
function canPublishLane(lane, recentLanes = []) {
  if (laneOf({ lane }) !== 'sport_wide') return { allowed: true, reason: null };

  const window = recentLanes.slice(0, SPORT_WIDE_WINDOW - 1);
  const clash = window.findIndex((l) => l === 'sport_wide');
  if (clash === -1) return { allowed: true, reason: null };

  return {
    allowed: false,
    reason: `sport_wide is capped at 1 in ${SPORT_WIDE_WINDOW} uploads; the last one was `
      + `${clash + 1} upload(s) ago. Publish ${SPORT_WIDE_WINDOW - 1 - clash} more football upload(s) first.`
  };
}

/**
 * Per-lane performance, for the publish-side digest.
 *
 * `videos` carry `{ lane, views, averageViewPercentage, subscribersGained }`.
 * Retention is averaged per video rather than weighted by views: the question
 * is whether the LANE holds an audience, and letting one outlier's watch time
 * carry the average is how a single lucky video keeps a dead lane alive.
 */
function laneStats(videos = []) {
  const out = {};
  for (const lane of LANES) {
    const rows = videos.filter((v) => laneOf(v) === lane);
    const views = rows.reduce((n, v) => n + (Number(v.views) || 0), 0);
    const subs = rows.reduce((n, v) => n + (Number(v.subscribersGained) || 0), 0);
    const retained = rows.map((v) => Number(v.averageViewPercentage)).filter(Number.isFinite);

    out[lane] = {
      uploads: rows.length,
      views,
      avgViews: rows.length ? Math.round(views / rows.length) : 0,
      retention: retained.length ? retained.reduce((a, b) => a + b, 0) / retained.length / 100 : null,
      subsPer1k: views ? (subs / views) * 1000 : null,
      subsGained: subs
    };
  }
  return out;
}

/**
 * The standing verdict on the sport_wide experiment.
 *
 * Deliberately refuses to answer early. "No relitigating before then" is the
 * rule, so before the threshold this returns `pending` and says how far off it
 * is, rather than offering a number that invites the argument.
 */
function laneVerdict(stats) {
  const total = LANES.reduce((n, l) => n + (stats[l]?.uploads || 0), 0);
  if (total < REVIEW_AT_UPLOADS) {
    return { decided: false, verdict: 'pending', uploads: total, remaining: REVIEW_AT_UPLOADS - total };
  }

  const wide = stats.sport_wide || {};
  const foot = stats.football || {};
  const beatsOnViews = (wide.avgViews || 0) > (foot.avgViews || 0);
  const holdsRetention = (wide.retention ?? 0) >= RETENTION_BAR;
  const shown = wide.retention === null || wide.retention === undefined
    ? 'n/a' : `${(wide.retention * 100).toFixed(1)}%`;

  return {
    decided: true,
    uploads: total,
    verdict: beatsOnViews && holdsRetention ? 'widen or flip' : 'cut the lane',
    beatsOnViews,
    holdsRetention,
    detail: `sport_wide ${wide.avgViews || 0} avg views vs football ${foot.avgViews || 0}; `
      + `retention ${shown} against a ${RETENTION_BAR * 100}% bar`
  };
}

module.exports = {
  LANES, DEFAULT_LANE, SPORT_WIDE_WINDOW, REVIEW_AT_UPLOADS, RETENTION_BAR,
  isBuildable, laneOf, canPublishLane, laneStats, laneVerdict
};
