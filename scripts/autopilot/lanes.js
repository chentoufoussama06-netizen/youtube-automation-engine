/**
 * The channels the autopilot runs, and what each one is about.
 *
 * Every lane makes the same product, because it is the only one the numbers
 * back: a 9-14 minute compilation built from Wikipedia briefs and Commons
 * photographs, posted once, then cut into one short a day that points back at
 * it. What differs is the niche the planner is told to stay inside and the
 * titles it is shown as the shape that wins there.
 *
 * 2026-10-22: every lane now runs story shorts, short and punchy (20-50s),
 * with plain fact-led titles (at most one emoji). Each lane has its own voice
 * and caption colour so the four channels do not read as one template.
 */

// Tuned to Football Files' own numbers (2026-10-08, 61 videos). Everything
// that broke 1,000 views was a 30-50s short whose title STATED a shocking
// fact about a death, collapse or disaster ("A football legend collapses
// mid-match and dies that same night." 1,278 views, 59% retention); the
// best retention of all was a twist ("Ten days after scoring an own goal,
// he was murdered." 95%). The 2-minute stories, news reposts and long-form
// never did. So: famous names, dark turns, 30-50 seconds, fact-led titles.
const DARK_FOOTBALL_STORY = {
  examples: [
    'A football legend collapses mid-match and dies that same night.  (1,278 views, 59% watched)',
    'Ten days after scoring an own goal, he was murdered.  (95% watched)',
    'A referee is assassinated after a controversial match.  (1,221 views)',
    'When Balotelli Completely Lost His Mind  (another channel: 4.4M)',
    'The Man Who DESTROYED the Galácticos  (another channel: 1.1M)'
  ],
  scope: 'About a FAMOUS footballer, manager, club or national team that casual fans\n'
    + '  worldwide know, at a DARK or shocking turn: a death, collapse, crime, scandal,\n'
    + '  disaster, meltdown, betrayal, a career destroyed overnight, karma.\n'
    + '- One specific episode. The title states the shocking fact or twist itself in\n'
    + '  plain words (like the first three examples), optionally ending with one emoji.',
  captionExample: 'Mario Balotelli',
  tags: ['football', 'football story', 'football tragedy'],
  words: { min: 75, target: 100, max: 135 }    // ~30-55s at Edge TTS pace
};

// All lanes share one Google project's 10,000 units/day (a short ~1,700), so
// order is priority: a lane that runs out of quota loses its posts, not others'.
const LANES = [
  {
    // An unused 49-subscriber channel connected 2026-10-08 (data root and
    // token file keep their first name, football2). Ancient history is the one
    // niche where several brand-new channels exploded at once in the
    // 2026-10-08 scan, so it is the topic and not luck: historicalmiracles
    // (15 days old) put 950K and 695K on its first 20-second battle shorts,
    // Rome Unscrolled (45 days) gets 20K-2M on every upload, Nils History
    // (3 months) 56K subs. One short a day, on purpose.
    name: 'Ancient History',
    dataRoot: 'state/football2',
    tokens: 'tokens.football2.json',
    categoryId: '27',             // Education
    voice: 'en-GB-RyanNeural',
    captionHighlight: '&H0033CCFF&',   // gold
    storyShortsPerDay: 1,
    docShortsPerDay: 0,
    story: {
      examples: [
        'Hannibal marches on the Romans  (15-day-old channel: 950K)',
        'The Battle of Cannae, 216 BCE.  (same channel: 695K)',
        'What Did People in Ancient Rome Actually Do All Day?  (45-day-old channel: 2.1M)',
        'The Library of Alexandria is Weirder Than You Think  (3-month-old channel: 2.1M)',
        'The Emperor Who Made His Horse a Senator'
      ],
      scope: 'A REAL, documented episode from the ancient world (Rome, Greece, Egypt, Carthage,\n'
        + '  Persia, the Bronze Age, Mesopotamia, the Celts and Germanic tribes) that a casual\n'
        + '  viewer has half-heard of or will not believe: a famous battle, an emperor\'s\n'
        + '  madness or murder, a betrayal, a siege, a lost city, a bizarre law or custom.\n'
        + '- One specific episode with a clear arc and a payoff. The title names it plainly\n'
        + '  (like the examples), optionally ending with one emoji.',
      captionExample: 'Hannibal',
      tags: ['ancient history', 'roman empire', 'history'],
      // The 950K/695K battle shorts above run ~20s: 22-38s here (check-video
      // rejects anything under 20s).
      words: { min: 55, target: 70, max: 95 }
    }
  },
  {
    name: 'Football Files',
    dataRoot: 'state/football',
    tokens: 'tokens.json',
    categoryId: '17',             // Sports
    voice: 'en-US-BrianNeural',
    captionHighlight: '&H004040FF&',   // red
    // Two story shorts a day. The compilation pipeline stays for long-form
    // and watch hours.
    storyShortsPerDay: 2,
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
    voice: 'en-US-AndrewNeural',
    captionHighlight: '&H00FFFF00&',   // cyan
    // Story shorts, not segments cut from compilations: the compilation
    // builder ran dry and failed renders, which left this channel with nothing
    // from 2026-10-12. Long-form still posts when a compilation is ready.
    storyShortsPerDay: 1,
    docShortsPerDay: 0,
    story: {
      examples: [
        'The Website That Vanished Overnight',
        'The Online Game That Shut Down While People Were Still Playing',
        'The Console That Destroyed Its Own Company',
        'How 1 YouTube Glitch Changed Lost Media Forever  (150K on a 1.8K-subscriber channel)',
        'The Hack That Took Down an Entire Platform'
      ],
      scope: 'A REAL, documented episode from tech and internet history that casual viewers\n'
        + '  half-remember: a website or app that died, an online game shut down, a console or\n'
        + '  gadget that flopped and sank its maker, a famous hack or leak, a lost-media mystery,\n'
        + '  a tech company\'s collapse.\n'
        + '- One specific episode with a clear arc and a payoff. The title states the twist plainly.',
      captionExample: 'Atari Jaguar',
      tags: ['tech history', 'lost media', 'internet history'],
      words: { min: 75, target: 95, max: 125 }    // ~30-50s
    },
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
    captionHighlight: '&H0000FF80&',   // green
    storyShortsPerDay: 1,
    docShortsPerDay: 0,
    story: {
      examples: [
        'This War Story Really Happened  (format: 3.1M, 38-day-old channel)',
        'He Jumped Into a Volcano to Prove He Was God  (1.3M)',
        'A Real-Life Miracle That Will Give You Chills  (format: 1.9M)',
        'The Soldier Who Kept Fighting 29 Years After the War Ended',
        'He Survived Both Atomic Bombs'
      ],
      scope: 'A REAL, documented event or person so unbelievable it sounds made up:\n'
        + '  war stories, impossible survivals, bizarre history, disasters, mysteries,\n'
        + '  heists, escapes, strange deaths, accidental discoveries. Any era, any country.\n'
        + '- One specific episode with a clear arc and a twist ending the viewer will not see coming.',
      captionExample: 'Hiroo Onoda',
      tags: ['true story', 'history', 'unbelievable'],
      words: { min: 75, target: 95, max: 125 }    // ~30-50s
    }
  }
];

module.exports = { LANES };
