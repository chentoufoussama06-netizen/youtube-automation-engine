/**
 * The channels the autopilot runs, and what each one is about.
 *
 * Every lane makes the same product, because it is the only one the numbers
 * back: a 9-14 minute compilation built from Wikipedia briefs and Commons
 * photographs, posted once, then cut into one short a day that points back at
 * it. What differs is the niche the planner is told to stay inside and the
 * titles it is shown as the shape that wins there.
 *
 * Viral Vault Clip is deliberately absent. Its format is third-party stream
 * footage, which is what throttled Football Files in September, and the
 * Reddit-over-gameplay replacement got 0 views on all six of its uploads.
 */

// Tuned to Football Files' own numbers (2026-10-08, 61 videos). Everything
// that broke 1,000 views was a 30-50s short whose title STATED a shocking
// fact about a death, collapse or disaster ("A football legend collapses
// mid-match and dies that same night." 1,278 views, 59% retention); the
// best retention of all was a twist ("Ten days after scoring an own goal,
// he was murdered." 95%). The 2-minute stories, news reposts and long-form
// never did. So: famous names, dark turns, ~60-80 seconds, fact-led titles.
const DARK_FOOTBALL_STORY = {
  examples: [
    'A football legend collapses mid-match and dies that same night.  (1,278 views, 59% watched)',
    'Ten days after scoring an own goal, he was murdered.  (95% watched)',
    'A referee is assassinated after a controversial match.  (1,221 views)',
    'When Balotelli Completely Lost His Mind 😭🔥  (another channel: 4.4M)',
    'The Man Who DESTROYED the Galácticos 💀  (another channel: 1.1M)'
  ],
  scope: 'About a FAMOUS footballer, manager, club or national team that casual fans\n'
    + '  worldwide know, at a DARK or shocking turn: a death, collapse, crime, scandal,\n'
    + '  disaster, meltdown, betrayal, a career destroyed overnight, karma.\n'
    + '- One specific episode. The title states the shocking fact or twist itself in\n'
    + '  plain words (like the first three examples), optionally ending with one emoji.',
  captionExample: 'Mario Balotelli',
  tags: ['football', 'football story', 'football tragedy'],
  words: { min: 140, target: 175, max: 220 }
};

// All lanes share one Google project's 10,000 units/day (a short ~1,700), so
// order is priority: a lane that runs out of quota loses its posts, not others'.
const LANES = [
  {
    // An unused 49-subscriber channel connected 2026-10-08. Football Files'
    // distribution collapsed in September (median views 767 -> 3) while the
    // format kept winning, so the proven shorts go to a clean channel first.
    name: 'Football Stories',
    dataRoot: 'state/football2',
    tokens: 'tokens.football2.json',
    categoryId: '17',             // Sports
    voice: 'en-US-BrianNeural',
    storyShortsPerDay: 2,
    docShortsPerDay: 0,
    story: DARK_FOOTBALL_STORY
  },
  {
    name: 'Football Files',
    dataRoot: 'state/football',
    tokens: 'tokens.json',
    categoryId: '17',             // Sports
    voice: 'en-US-BrianNeural',
    // One story short a day while the channel is throttled; the quota it
    // freed goes to Football Stories. The compilation pipeline stays for
    // long-form and watch hours.
    storyShortsPerDay: 1,
    docShortsPerDay: 0,
    story: DARK_FOOTBALL_STORY,
    niche: 'Dark football documentaries: real tragedies, disasters, scandals, '
      + 'disappearances, crimes, cursed careers, collapses and rise-and-fall stories '
      + 'of real footballers, managers, clubs, referees and matches, from any country and era.',
    winningTitles: [
      'The Tragic Deaths of World Cup Players (362K views on an 8.5K-subscriber channel)',
      'How Every Football Legend Died (1.9M views on an 8.5K-subscriber channel)',
      'Every Footballer Who Collapsed On The Pitch',
      'Every Football Team Destroyed By A Plane Crash'
    ]
  },
  {
    name: 'AFTER CACHE',
    dataRoot: 'state/aftercache',
    tokens: 'tokens.aftercache.json',
    categoryId: '27',             // Education
    voice: 'en-US-BrianNeural',
    storyShortsPerDay: 0,
    docShortsPerDay: 1,
    niche: 'Digital investigations: lost media, shut-down online games, vanished websites, '
      + 'deleted platforms, failed consoles and gadgets, internet mysteries, hacks and leaks, '
      + 'and the companies and people behind them.',
    winningTitles: [
      'How 1 YouTube Glitch Changed Lost Media Forever (150K views on a 1.8K-subscriber channel)',
      'Every Online Game That Was Shut Down While People Were Still Playing',
      'The Websites That Vanished Overnight',
      'Every Video Game Console That Destroyed Its Company'
    ]
  },
  {
    // Unbelievable-but-true stories: war, survival, disasters, history. Picked
    // from the 2026-10-07 scan: "War facts" (38 days old) put 3.1M on "3 WAR
    // STORIES THAT REALLY HAPPENED"; The P2 Facts reached 567K subs in 96 days
    // on real-life miracles; Veilix (97M views) on "He Jumped Into a Volcano to
    // Prove He Was God". All Wikipedia-sourced, and Commons is deep in public-
    // domain wartime and historical photographs. Replaces the Reddit loop that
    // got 0 views on all six of this channel's uploads.
    name: 'Viral Vault Clip',
    dataRoot: 'state/clips-channel',
    tokens: 'tokens.clips.json',
    categoryId: '27',             // Education
    voice: 'en-US-ChristopherNeural',
    storyShortsPerDay: 1,
    docShortsPerDay: 0,
    story: {
      examples: [
        '3 War Stories That Really Happened 😳  (3.1M, 38-day-old channel)',
        'He Jumped Into a Volcano to Prove He Was God 💀  (1.3M)',
        '3 Creepy Real-Life Miracles That Will Give You Chills 😨  (1.9M)',
        'The Soldier Who Kept Fighting 29 Years After the War Ended 🤯',
        'He Survived Both Atomic Bombs 😳'
      ],
      scope: 'A REAL, documented event or person so unbelievable it sounds made up:\n'
        + '  war stories, impossible survivals, bizarre history, disasters, mysteries,\n'
        + '  heists, escapes, strange deaths, accidental discoveries. Any era, any country.\n'
        + '- One specific episode with a clear arc and a payoff the viewer will not see coming.',
      captionExample: 'Hiroo Onoda',
      tags: ['true story', 'history', 'unbelievable']
    }
  }
];

module.exports = { LANES };
