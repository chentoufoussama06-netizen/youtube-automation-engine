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
 *
 * 2026-10-30: the five daily story slots went where the audience is. In the
 * week to 2026-10-27 Football Files drew 1,945 views (89 the week before) and
 * Ancient History 1,345 (4), while AFTER CACHE drew 4 and Viral Vault Clip 3
 * — their best story shorts sat at 2 and 13 views. So Football Files 3,
 * Ancient History 2, and the other two post long-form only. The total stays
 * five because the upload quota (see below) does not stretch to six. A lane
 * at 0 shorts is also left out of the workflow's "did not post" check.
 *
 * Later the same day: YouTube's quota table now gives videos.insert its own
 * bucket of 100 calls a day instead of 1,600 of the shared 10,000 units, so
 * that ceiling is gone. AFTER CACHE and Viral Vault Clip post again (one a
 * day each), and every lane uses the v2 look (utils/short-style-v2.js).
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
    // (3 months) 56K subs. Two a day from 2026-10-30, once it proved itself
    // (Elagabalus, 1,316 views).
    name: 'Ancient History',
    dataRoot: 'state/football2',
    tokens: 'tokens.football2.json',
    categoryId: '27',             // Education
    voice: 'en-GB-RyanNeural',
    captionHighlight: '&H0033CCFF&',   // gold
    storyShortsPerDay: 2,
    // The v2 look (utils/short-style-v2.js) with a warm, grained grade.
    look: 'ancient',
    v2: 'on',
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
    // Three story shorts a day (two until 2026-10-30). The compilation
    // pipeline stays for long-form and watch hours.
    storyShortsPerDay: 3,
    // The story picker also reads the last two days of football headlines
    // (Wikipedia must still document the episode), and on Sundays the week's
    // Fabrizio Romano reporting goes out as one roundup (romano-weekly.js).
    news: true,
    romanoWeekly: true,
    // From 2026-10-31 the first story slot posts the planned series of
    // legendary moments, one part a day (autopilot/series.js): Leicester
    // 5000-1, Real Madrid 2022, Ajax 1995, Rogério Ceni, Pep Guardiola.
    series: true,
    // The v2 look (utils/short-style-v2.js) on every short. 'ab' alternates it
    // with the first look by count, if a side-by-side measure is ever wanted.
    look: 'football',
    v2: 'on',
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
    // 2026-11-07: restarted on one niche, military gear that went mainstream,
    // one story short a day. It was paused from 2026-11-04 (2 views from the
    // Shorts feed in 28 days on its old Reddit, lost-media and tech-history
    // mix; every old video unlisted). Its old tech compilations are still on
    // disk, so long-form stays off: nothing from the old niche goes out.
    paused: true,                 // until the cloud previews pass
    storyShortsPerDay: 1,
    longform: false,
    look: 'football',             // clean grade, bold box
    theme: 'military',            // soldiers and aircraft clips, military music
    v2: 'on',
    docShortsPerDay: 0,
    story: {
      examples: [
        'The trench coat was made for the trenches of World War I.',
        'Duct tape was invented to keep ammunition boxes dry in World War II.',
        'Aviator sunglasses were built for fighter pilots long before Hollywood wore them.',
        'The microwave oven exists because a radar engineer\'s chocolate bar melted.',
        'M&M\'s were made so soldiers could carry chocolate that would not melt.'
      ],
      scope: 'A REAL, documented everyday object, piece of clothing, food or technology that\n'
        + '  began as military gear, a soldier\'s ration or a wartime invention and became\n'
        + '  something ordinary people use every day: which war or army, why soldiers needed\n'
        + '  it, and how it reached everyone else.\n'
        + '- One specific item with a clear arc and a twist. The title states the surprising\n'
        + '  origin plainly, as a fact (like the examples).',
      captionExample: 'Trench coat',
      tags: ['military history', 'everyday objects', 'history facts'],
      words: { min: 75, target: 95, max: 125 }    // ~30-50s
    },
    niche: 'Military gear that went mainstream: everyday objects, clothes, food and technology '
      + 'that began as military equipment, rations or wartime inventions.',
    winningTitles: [
      'Everyday Things That Were Invented for War',
      'Clothes You Wear That Were Designed for Soldiers',
      'Foods That Started as Military Rations'
    ]
  },
  {
    name: 'Viral Vault Clip',
    dataRoot: 'state/clips-channel',
    tokens: 'tokens.clips.json',
    categoryId: '27',             // Education
    voice: 'en-US-ChristopherNeural',
    captionHighlight: '&H0000FF80&',   // green
    // 2026-11-07: restarted on one niche, lesser-known shipwrecks, one story
    // short a day. It was paused from 2026-11-04 (0 views from the Shorts feed
    // in 28 days on its old reposted clips; every old video unlisted). The warm
    // grade suits the archive photographs Commons has of old ships.
    paused: true,                 // until the cloud previews pass
    storyShortsPerDay: 1,
    longform: false,
    look: 'ancient',              // warm archive grade, gold box
    theme: 'sea',                 // storm and underwater clips, dark music
    v2: 'on',
    docShortsPerDay: 0,
    story: {
      examples: [
        'A brand-new warship sank before it even left the harbour.',
        'A passenger ship capsized while still tied to the dock, killing 844 people.',
        'The deadliest shipwreck in history was not the Titanic.',
        'A passenger liner vanished in 1909 and has never been found.',
        'The shipwreck survivors who were murdered by their own crew.'
      ],
      scope: 'A REAL, documented shipwreck or disaster at sea that most people have never heard\n'
        + '  of: a sinking, a ship that vanished, a mutiny, a ghost ship, a wreck found decades\n'
        + '  later. Any era, any country. The Titanic and the Lusitania may be mentioned for\n'
        + '  scale but are never the story.\n'
        + '- One specific ship and episode with a clear arc and a twist. The title states the\n'
        + '  shocking fact plainly (like the examples).',
      captionExample: 'Vasa',
      tags: ['shipwreck', 'maritime history', 'ocean mysteries'],
      words: { min: 75, target: 95, max: 125 }    // ~30-50s
    },
    niche: 'Lesser-known shipwrecks: forgotten sinkings, vanished ships, mutinies, ghost ships '
      + 'and wrecks found decades later.',
    winningTitles: [
      'Shipwrecks Nobody Talks About',
      'Ships That Vanished Without a Trace',
      'The Deadliest Shipwrecks That Were Not the Titanic'
    ]
  }
];

module.exports = { LANES };
