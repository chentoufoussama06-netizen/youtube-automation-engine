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
    + '- NOT career trivia: a debut, a first club, a nomination, an award or a goal\n'
    + '  record on its own (Haaland at Bryne, Vinícius debuts at 16, Salah\'s 32 goals:\n'
    + '  84-305 views each on 8-9 Nov, against ~1,000 for every dark story).\n'
    + '- One specific episode. The title states the shocking fact or twist itself in\n'
    + '  plain words (like the first three examples), optionally ending with one emoji.',
  captionExample: 'Mario Balotelli',
  tags: ['football', 'football story', 'football tragedy'],
  // ~30-55s. The 7 Nov move to 20-30s star shorts (58-80 words) went with the
  // channel's worst run: 84-305 views a post against ~1,000 at this length.
  words: { min: 75, target: 100, max: 135 }
};

// Never made on Ancient Untold, whatever proposes them: between 12 and 16 Nov
// the trending list pulled in two Rama shorts (128 and 19 views) and a Battle
// of the Trench short about Muhammad, which was only lost to an upload bug.
// Pictures of a prophet or a god are not this channel's to make.
const ANCIENT_AVOID = /\b(muhammad|mohammed|mahomet|prophet|jesus|christ|moses|abraham|buddha|rama|krishna|shiva|vishnu|ramayana|mahabharata|quran|koran|bible|gospel|allah)\b/i;

/*
 * Format tests (2026-11-20, the user: "make these channels reach millions").
 * Every short on the four channels stopped at the ~1,000-view first batch.
 * An API study of the Shorts that broke 1M in the month to 20 Nov:
 * - history: a median 76s, curiosity explainers ("The Secret Engineering
 *   Behind Rani Ki Vav" 16.4M on a 17k-subscriber channel, "How Did Ancient
 *   Humans Make the First Sharp Stone Tools?" 9.2M on 36k);
 * - football: a median 48s, about megastars told with emotion or curiosity
 *   (Ronaldo above all; Mourinho's "Special One" 6.2M, Yamal and his little
 *   brother 4.7M on a 28k-subscriber channel), not trivia.
 * A lane's `test` takes `perDay` of its story slots (autopilot.js); a test
 * story that finds nothing hands its slot to an ordinary one. Stories record
 * `variant`, so stay rate and 48h views can be compared slot against slot.
 */
const EXPLAINER_STORY = {
  examples: [
    'The Secret Engineering Behind Rani Ki Vav  (17k-subscriber channel: 16.4M)',
    'How Did Ancient Humans Make the First Sharp Stone Tools?  (36k-subscriber channel: 9.2M)',
    'How the Aztecs Fed Millions Without Cows or Sheep  (16k-subscriber channel: 1.5M)',
    'The Dark History of Treadmills  (121k-subscriber channel: 1.8M)',
    'Caracalla Killed While Using the Loo  (this channel: 1,222, one of its best)'
  ],
  scope: 'HOW or WHY something in the ancient world worked, that a casual viewer never\n'
    + '  thought about and will hardly believe: engineering (Roman concrete, aqueducts,\n'
    + '  the pyramids, the Antikythera mechanism, Greek fire), daily life (toilets, teeth,\n'
    + '  food, heating, cosmetics), medicine, a strange invention, a lost technique, the\n'
    + '  ancient origin of something we still use. Rome, Greece, Egypt, Mesopotamia,\n'
    + '  Persia, Carthage, the Celts. Nothing after 500 CE; no religions or scripture.\n'
    + '- "article": the thing itself ("Roman concrete", "Antikythera mechanism"), whose\n'
    + '  article explains how it worked. "moment": the one surprising fact the short\n'
    + '  explains, with its date or era.',
  titleRule: 'under 60 characters, a curiosity question or reveal about the thing people\n'
    + '  know: "How Did ...?", "Why ...?", "The Secret Behind ...", "The Dark History of\n'
    + '  ...". No emoji. Never promise something the article cannot back.',
  writerNote: 'This short EXPLAINS how or why it worked, like a sharp documentary, not a battle\n'
    + 'story. Open on the most surprising fact, then the question it raises, then the\n'
    + 'answer in 3 to 5 concrete steps the SOURCE gives (materials, numbers, how it was\n'
    + 'made or used), then why it still matters today. Every step must come from the SOURCE.',
  avoid: ANCIENT_AVOID,
  captionExample: 'Roman concrete',
  tags: ['ancient history', 'history facts', 'ancient engineering'],
  // 60-75s, the length of the history shorts that broke 1M (median 76s)
  words: { min: 145, target: 170, max: 200 }
};

// Names casual fans everywhere know (the football shorts that broke 1M).
const MEGASTARS = ['Cristiano Ronaldo', 'Lionel Messi', 'Neymar', 'Kylian Mbappé', 'Lamine Yamal', 'Erling Haaland',
  'Mohamed Salah', 'Vinícius Júnior', 'Jude Bellingham', 'Kevin De Bruyne', 'Luka Modrić', 'Zlatan Ibrahimović',
  'Ronaldinho', 'David Beckham', 'Zinedine Zidane', 'José Mourinho', 'Pep Guardiola', 'Sergio Ramos',
  'Robert Lewandowski', 'Harry Kane', 'Karim Benzema', 'Wayne Rooney', 'Thierry Henry', 'Ronaldo Nazário',
  'Kaká', 'Gianluigi Buffon', 'Andrés Iniesta', 'Son Heung-min', 'Diego Maradona', 'Pelé'];
const MEGASTAR_STORY = {
  examples: [
    'Ronaldo\'s Goat DNA Passed Down To His Sons  (352k-subscriber channel: 9.2M)',
    'This Is Where José Mourinho Became THE SPECIAL ONE  (164k-subscriber channel: 6.2M)',
    'Lamine Yamal & His Little Brother Keyne  (28k-subscriber channel: 4.7M)',
    'When Ronaldo Took Revenge On Atlético  (62k-subscriber channel: 1.4M)',
    'Seventeen minutes. That is all Karim Benzema needed.  (this channel: 2,871, its best)'
  ],
  scope: `About ONE of these megastars, the names that pull millions: ${MEGASTARS.join(', ')}.\n`
    + '  An emotional or surprising episode of their life that fans feel: family, a\n'
    + '  sacrifice, a childhood struggle, heartbreak, revenge, loyalty, a rivalry, a\n'
    + '  comeback, a strange habit or rule, the moment that changed everything.\n'
    + '- NOT career trivia on its own: a debut, a first club, a nomination, a goal\n'
    + '  record (Haaland at Bryne, Salah\'s 32 goals: 84-305 views each on 8-9 Nov).\n'
    + '- One specific episode, with its year.',
  titleRule: 'under 60 characters, opens on the megastar\'s name, an emotional or curiosity\n'
    + '  angle ("Why ...", "The Day ...", "When ..."), may be a question. At most one emoji.\n'
    + '  Never promise something the article cannot back.',
  // the subject (or its article) must be one of MEGASTARS
  only: /\b(ronaldo|messi|neymar|mbappe|yamal|haaland|salah|vinicius|bellingham|de bruyne|modric|ibrahimovic|zlatan|ronaldinho|beckham|zidane|mourinho|guardiola|sergio ramos|lewandowski|harry kane|benzema|rooney|thierry henry|kaka|buffon|iniesta|son heung|maradona|pele)\b/,
  // The picker reads real lines from these articles and chooses one. Given the
  // names alone it invented their lives (20 Nov preview: "Ronaldo's mother died
  // in 2005"; it was his father) and the article check refused every story.
  // From 2008 on, so Commons has photos of them from that time (the era rule).
  // Ronaldo Nazário is left out: as "Ronaldo" his photos mix with Cristiano's.
  bank: {
    articles: MEGASTARS.filter((n) => n !== 'Ronaldo Nazário'),
    subjects: 8,
    minYear: 2008,
    line: /\b(cried|crying|tears|wept|emotional|mother|father|parents|son|daughter|brother|sister|family|wife|died|death|funeral|injur(ed|y|ies)|surgery|retire(d|ment)?|heartbreak|lost|defeat|missed|final|revenge|rival(ry|s)?|loyal(ty)?|refused|rejected|donat(ed|ion|es)|charity|sacrific\w*|struggl\w*|poverty|childhood|comeback|returned|booed|insult\w*|apologi[sz]\w*|tribute|dedicat\w*|tattoo|banned|red card|sent off|suspen\w*|arrest\w*|prison|jail|kidnap\w*|threat\w*|racis\w*|abuse\w*|protest\w*|sacked|farewell|statue)\b/i,
    pick: 'the most EMOTIONAL or SURPRISING short for fans: family, a sacrifice, tears, heartbreak, revenge, '
      + 'loyalty, a rivalry, a comeback, a strange habit or rule, the moment that changed a career. Answer line 0 '
      + 'for a subject with only routine career facts (caps, transfers, goal counts, an award on its own).',
    title: 'under 60 characters, opening on the megastar\'s name, an emotional or curiosity angle ("Why ...", '
      + '"The Day ...", "When ..."), may be a question, no emoji.'
  },
  captionExample: 'Cristiano Ronaldo',
  tags: ['football', 'football story', 'football legends'],
  // 40-50s, around the 48s median of the football shorts that broke 1M
  words: { min: 100, target: 120, max: 140 }
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
        + '  (like the examples), optionally ending with one emoji.\n'
        + '- History only: no prophets, founders of religions, gods or scripture stories\n'
        + '  (Muhammad, Jesus, Moses, Buddha, Rama, Krishna), and nothing after 500 CE.',
      avoid: ANCIENT_AVOID,
      captionExample: 'Hannibal',
      tags: ['ancient history', 'roman empire', 'history'],
      // The 950K/695K battle shorts above run ~20s: 22-38s here (check-video
      // rejects anything under 20s).
      // back to the range of its ~1,000-view weeks (23 Oct - 7 Nov)
      words: { min: 55, target: 70, max: 95 }
    },
    // One of the two daily shorts (2026-11-20 test, see EXPLAINER_STORY).
    // 60-75s needs more pictures than a 25s battle short.
    test: { name: 'explainer', perDay: 1, story: EXPLAINER_STORY, minPhotos: 6 }
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
    // Real footage of the story from Wikimedia Commons when it exists
    // (newsreels, clubs' own CC video): utils/archive-footage.js, 9 Nov.
    archiveFootage: true,
    docShortsPerDay: 0,
    story: DARK_FOOTBALL_STORY,
    // One of the daily shorts (2026-11-20 test, see MEGASTAR_STORY). Its first
    // preview made nothing: from the names alone the picker invented life
    // events. Picking from the articles' own lines, the second (21 Nov) made
    // two that the reviewer passed: Iniesta's 2010 goal for Dani Jarque, and
    // the one photo of Zlatan's feet his wife allows on the wall.
    test: { name: 'megastar', perDay: 1, story: MEGASTAR_STORY },
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
      // Read by the narration writer (story-short.js), unlike scope, which picks the story.
      writerNote: 'Write "the US", "the UK" and names without initials ("Roy Plunkett", not "Roy J. Plunkett"):'
        + ' a period inside a sentence splits it for the fact-check and the sentence is lost.',
      captionExample: 'Trench coat',
      tags: ['military history', 'everyday objects', 'history facts'],
      words: { min: 58, target: 66, max: 80 }     // ~20-30s (2026-11-07 strategy)
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
      // Read by the narration writer (story-short.js), unlike scope, which picks the story.
      writerNote: 'Write "the US", "the UK" and names without initials ("Roy Plunkett", not "Roy J. Plunkett"):'
        + ' a period inside a sentence splits it for the fact-check and the sentence is lost.',
      captionExample: 'Vasa',
      tags: ['shipwreck', 'maritime history', 'ocean mysteries'],
      words: { min: 58, target: 66, max: 80 }     // ~20-30s (2026-11-07 strategy)
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
