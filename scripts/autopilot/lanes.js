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

const LANES = [
  {
    name: 'Football Files',
    dataRoot: 'state/football',
    tokens: 'tokens.json',
    categoryId: '17',             // Sports
    voice: 'en-US-BrianNeural',
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
    niche: 'Digital investigations: lost media, shut-down online games, vanished websites, '
      + 'deleted platforms, failed consoles and gadgets, internet mysteries, hacks and leaks, '
      + 'and the companies and people behind them.',
    winningTitles: [
      'How 1 YouTube Glitch Changed Lost Media Forever (150K views on a 1.8K-subscriber channel)',
      'Every Online Game That Was Shut Down While People Were Still Playing',
      'The Websites That Vanished Overnight',
      'Every Video Game Console That Destroyed Its Company'
    ]
  }
];

module.exports = { LANES };
