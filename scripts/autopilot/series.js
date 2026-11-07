/**
 * Planned football series: the rare, legendary moments, told in parts.
 *
 * Picked 2026-10-31 from a list of 30 (miracles, comebacks, revolutions,
 * things that will never happen again), in this order: Leicester 5000-1,
 * Real Madrid's 2022 run, Ajax 1995, Rogério Ceni, how Pep changed football.
 *
 * Unlike autopilot/sequels.js (a Part 2 only for a short that already pulled a
 * crowd), these are planned up front, because the story itself has acts: each
 * part ends on the real turning point and says the next part is coming, so a
 * part must never be left without its next one. One part a day, in a lane's
 * first story slot, Part 1 to the last, then the next series.
 *
 * Every part is checked like any story short: its moment against its own
 * articles (all checked by hand on 2026-10-31 for the facts named here), its
 * narration sentence by sentence, and its teaser — the line that sells the
 * next part — against the NEXT part's articles. A teaser the checker cannot
 * back is dropped for a plain "Part two is next."
 *
 *   articles  English Wikipedia articles the narration is written and checked from
 *   photos    where the pictures come from: [{ article, n, names }]. `names`
 *             makes the picture follow the narration — every time the voice
 *             says "Rodrygo", Rodrygo's photos come up (short-style-v2.js).
 *             A group without names is the general pool the video opens on.
 *             `skip` (a regex on file names) keeps out a photo that would give
 *             away a later part.
 *   label     the match or season, shown under the Part tag
 *   note      anything the writer must be told about the source
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch { return fb; } };

const SERIES = [
  {
    key: 'leicester-5000-1',
    name: 'Leicester City 5000-1',
    parts: [
      {
        articles: ['2014–15 Leicester City F.C. season', 'Leicester City F.C.', '2015–16 Leicester City F.C. season'],
        subject: 'Leicester City',
        // Commons has few photos of the club itself (the first preview was
        // mostly the stadium), so the squad of that escape fills it out, and
        // Part 2's striker comes up on the teaser's "a striker".
        // The trophy lift would give away Part 3.
        photos: [{ article: 'Leicester City F.C.', n: 3, skip: 'lift|trophy|champion' }, { article: 'Wes Morgan', n: 2, names: ['foxes', 'relegation'] },
          { article: 'Kasper Schmeichel', n: 2, names: ['table', 'turnaround'] },
          { article: 'Claudio Ranieri', n: 4, names: ['ranieri', 'claudio'], skip: 'lift|trophy|champion' },
          { article: 'Jamie Vardy', n: 2, names: ['striker'] }],
        label: 'Leicester City · 2014–2016',
        moment: 'In 2014–15 Leicester City spent four and a half months bottom of the Premier League and survived with seven wins from their last nine games; in July 2015 they appointed Claudio Ranieri to a sceptical reaction, and bookmakers made them 5000–1 to win the league.',
        title: 'Bottom of the League, Then 5000-1 to Win It',
        teaser: 'Then a striker who came from non-League football started scoring, and he would not stop.'
      },
      {
        articles: ['Jamie Vardy', '2015–16 Leicester City F.C. season'],
        subject: 'Jamie Vardy',
        photos: [{ article: 'Jamie Vardy', n: 6, names: ['vardy', 'jamie'] }, { article: 'Riyad Mahrez', n: 2, names: ['mahrez', 'riyad'] },
          { article: "N'Golo Kanté", n: 2, names: ['kante', 'ngolo'] }],
        label: 'Leicester City · 2015–16',
        moment: 'In the 2015–16 Premier League season Jamie Vardy, released by Sheffield Wednesday at 16 and once paid £120 a week at Stocksbridge Park Steels, scored in 11 consecutive Premier League matches and broke Ruud van Nistelrooy\'s record.',
        title: 'From £120 a Week to a Premier League Record',
        teaser: 'And the 5000–1 outsiders were now chasing the title.'
      },
      {
        articles: ['2015–16 Leicester City F.C. season', 'Leicester City F.C.'],
        subject: 'Leicester City',
        photos: [{ article: 'Leicester City F.C.', n: 3 }, { article: 'Claudio Ranieri', n: 3, names: ['ranieri', 'claudio'] },
          { article: 'Wes Morgan', n: 2, names: ['morgan', 'wes'] }, { article: 'Jamie Vardy', n: 2, names: ['vardy'] }],
        label: 'Premier League · 2 May 2016',
        moment: 'On 2 May 2016 Leicester City, 5000–1 underdogs before the season, were crowned Premier League champions when Chelsea came from two goals down to draw 2–2 with Tottenham Hotspur at Stamford Bridge.',
        title: 'The Night Chelsea Made Leicester Champions',
        teaser: 'Less than a year later, the man who made it happen was dismissed.'
      },
      {
        articles: ['Claudio Ranieri'],
        subject: 'Claudio Ranieri',
        photos: [{ article: 'Claudio Ranieri', n: 7 }, { article: 'Leicester City F.C.', n: 2, names: ['leicester'] }],
        label: 'Leicester City · February 2017',
        moment: 'On 23 February 2017, weeks after winning the Best FIFA Men\'s Coach award, Claudio Ranieri was dismissed by Leicester City with the club one point above the relegation zone, a decision Gary Lineker called "wrong".',
        title: 'Champions in May, Dismissed by February',
        note: 'This is the last part: land the whole Leicester story in the final line.'
      }
    ]
  },
  {
    key: 'real-madrid-2022',
    name: 'Real Madrid 2022: The Impossible Run',
    parts: [
      {
        articles: ['2021–22 Real Madrid CF season', 'Karim Benzema'],
        subject: 'Karim Benzema',
        photos: [{ article: 'Karim Benzema', n: 6, names: ['benzema', 'karim'] }, { article: 'Kylian Mbappé', n: 2, names: ['mbappe', 'kylian'] },
          { article: 'Santiago Bernabéu Stadium', n: 2, names: ['bernabeu'] }],
        label: 'Real Madrid v PSG · 2022',
        moment: 'On 9 March 2022, behind against Paris Saint-Germain in the Champions League round of 16, Real Madrid came back to win 3–1 on the night when Karim Benzema scored a hat-trick within 17 minutes.',
        title: 'Benzema\'s 17-Minute Hat-Trick That Broke PSG',
        teaser: 'Next came the defending champions, Chelsea.'
      },
      {
        articles: ['2021–22 Real Madrid CF season', 'Rodrygo', 'Karim Benzema'],
        subject: 'Real Madrid',
        photos: [{ article: 'Karim Benzema', n: 4, names: ['benzema', 'karim'] }, { article: 'Rodrygo', n: 4, names: ['rodrygo'] },
          { article: 'Stamford Bridge (stadium)', n: 1, names: ['stamford'] }],
        label: 'Real Madrid v Chelsea · 2022',
        moment: 'In the April 2022 Champions League quarter-final Real Madrid beat Chelsea 3–1 at Stamford Bridge with a Benzema hat-trick, lost the second leg 3–2 at home, and went through 5–4 on aggregate after a late Rodrygo volley and a Benzema header in extra time.',
        title: 'Chelsea Had Them Beaten. Then Rodrygo Came On.',
        teaser: 'In the semi-final, Manchester City were ahead at the 90th minute.'
      },
      {
        articles: ['Rodrygo', '2021–22 Real Madrid CF season', 'Karim Benzema'],
        subject: 'Rodrygo',
        photos: [{ article: 'Rodrygo', n: 5, names: ['rodrygo'] }, { article: 'Karim Benzema', n: 3, names: ['benzema', 'karim'] },
          { article: 'Pep Guardiola', n: 1, names: ['guardiola', 'pep'] }],
        label: 'Real Madrid v Man City · 2022',
        moment: 'On 4 May 2022, trailing Manchester City 0–1 on the night and 3–5 on aggregate in the Champions League semi-final, Rodrygo scored two goals between the 90th and 91st minutes and Benzema\'s extra-time penalty sent Real Madrid to the final.',
        title: 'Two Goals in Two Minutes Against Man City',
        teaser: 'One game left: the final, against Liverpool.'
      },
      {
        articles: ['2022 UEFA Champions League final'],
        subject: 'Real Madrid',
        photos: [{ article: '2022 UEFA Champions League final', n: 4 }, { article: 'Thibaut Courtois', n: 3, names: ['courtois', 'thibaut'] },
          { article: 'Vinícius Júnior', n: 3, names: ['vinicius'] }],
        label: 'Champions League Final · 2022',
        moment: 'On 28 May 2022, after a kickoff delayed by 36 minutes, Real Madrid beat Liverpool 1–0 in the Champions League final at the Stade de France with a 59th-minute Vinícius Júnior goal while Thibaut Courtois saved shot after shot.',
        title: 'Liverpool Kept Shooting. Courtois Kept Saving.',
        note: 'This is the last part: land the whole 2022 run (PSG, Chelsea, City, Liverpool) in the final line.'
      }
    ]
  },
  {
    // Added 2026-11-07 at the user's request, to run right after Real Madrid
    // 2022. The thread through every part is the article's own point: he
    // trusted the players he had coached in Spain's youth teams (Merino, Olmo,
    // Oyarzabal, Fabián Ruiz and Unai Simón won the 2019 under-21 title under
    // him), and they decided his finals. All facts checked by hand on
    // 2026-11-07 against the articles named here.
    key: 'de-la-fuente',
    // Photos rebuilt 2026-11-07 after the user saw Part 1 cut between two
    // photos from the wrong year: each beat now shows that beat (De Kuip on
    // the penalties, the Madrid celebration on the trophy, the 2026 final set
    // in Part 5), hand-picked from Commons where it has the event.
    name: 'Luis de la Fuente: The Quiet Genius',
    parts: [
      {
        articles: ['Luis de la Fuente (footballer, born 1961)', 'Luis Enrique'],
        subject: 'Luis de la Fuente',
        photos: [
          {files: ["Luis de la Fuente Castillo - 2023 05 06 Final de la Copa del Rey 0001 (cropped).jpg","Luis de la Fuente.jpg"], names: ["fuente","luis","coach"]},
          {files: ["Luis Enrique 2014.jpg"], names: ["enrique","resigned","morocco"]}
        ],
        label: 'Spain · December 2022',
        moment: 'On 8 December 2022, after Luis Enrique resigned when Morocco knocked Spain out of the World Cup on penalties, Spain appointed Luis de la Fuente, a youth coach who had won the 2015 under-19 and 2019 under-21 European Championships and Olympic silver in Tokyo.',
        title: 'Spain Lost to Morocco, So They Hired Their Youth Coach',
        teaser: 'His first final was in Rotterdam, against Croatia.',
        note: 'Stay with what the source says: he had coached Spain\'s youth teams for years and won with them. Do not say what fans or the press expected.'
      },
      {
        articles: ['2023 UEFA Nations League final', 'Luis de la Fuente (footballer, born 1961)'],
        subject: 'Luis de la Fuente',
        photos: [
          {files: ["De Kuip, Rotterdam (32426274167).jpg","StadionFeyenoord.jpg"]},
          {files: ["Luis de la Fuente Castillo - 2023 05 06 Final de la Copa del Rey 0001 (cropped).jpg","Luis de la Fuente.jpg"], names: ["fuente","luis","coach"]},
          {files: ["Joselu espanyol 2022 (cropped).jpg"], names: ["joselu","debutant","norway"]},
          {files: ["Unai Simon Argentina v Spain 19 July 2026-078 (cropped).jpg","Unai Simon France v Spain 7.24.26-118 (cropped).jpg"], names: ["simon","unai","saved","saves","penalties","shootout","keeper","goalkeeper"]},
          {files: ["UEFA EURO qualifiers Sweden vs Spain 20191015 Dani Carvajal 10 (cropped).jpg"], names: ["carvajal","chipped","chip"]}
        ],
        label: 'Nations League Final · 2023',
        moment: 'In Luis de la Fuente\'s first game, on 25 March 2023, 32-year-old debutant Joselu scored twice in a 3–0 win over Norway, and on 18 June 2023 in Rotterdam Spain beat Croatia 5–4 on penalties after a 0–0 draw, with Unai Simón saving twice and Dani Carvajal chipping the winning kick, for their first Nations League title.',
        title: 'The Chipped Penalty That Won Spain a Trophy',
        teaser: 'Next came Euro 2024, and a 16-year-old winger.',
        note: 'Unai Simón won the 2019 under-21 title under de la Fuente: say the keeper he trusted from his youth team saved it.'
      },
      {
        articles: ['UEFA Euro 2024 final', 'Lamine Yamal', 'Luis de la Fuente (footballer, born 1961)'],
        subject: 'Lamine Yamal',
        photos: [
          {files: ["2024-07-05 UEFA Euro 2024 Fan Zone Berlin Brandenburger Tor by Sandro Halank–002.jpg","2024-07-05 UEFA Euro 2024 Fan Zone Berlin Brandenburger Tor by Sandro Halank–009.jpg","2024-07-05 UEFA Euro 2024 Fan Zone Berlin Brandenburger Tor by Sandro Halank–012.jpg"]},
          {files: ["Lamine Yamal in 2025.jpg","Lamine Yamal France v Spain 7.24.26-187.jpg"], names: ["yamal","lamine","teenager","winger"]},
          {files: ["Mikel Merino France v Spain 7.24.26-241 (cropped).jpg"], names: ["merino","header","headed"]},
          {files: ["Dani Olmo France v Spain 7.24.26-176 (cropped).jpg"], names: ["olmo"]},
          {files: ["Luis de la Fuente.jpg"], names: ["fuente","coach"]}
        ],
        label: 'Euro 2024 · Germany',
        moment: 'At Euro 2024 Spain won their group without conceding, knocked out hosts Germany 2–1 with a Mikel Merino header in the 119th minute, and in the semi-final against France teenager Lamine Yamal equalised from outside the box before Dani Olmo scored the winner.',
        title: 'Spain Knocked Out Germany in the 119th Minute',
        teaser: 'One game left: England, in Berlin.',
        note: 'Merino and Olmo won the 2019 under-21 title under de la Fuente: his own youth players decided both games. Do not tell the final.'
      },
      {
        articles: ['UEFA Euro 2024 final'],   // alone, so both goal paragraphs fit the brief
        subject: 'Spain',
        photos: [
          {files: ["Fiesta Celebracion Eurocopa 2024 - Madrid 03.jpg","Fiesta Celebracion Eurocopa 2024 - Madrid 06.jpg","Fiesta Celebracion Eurocopa 2024 - Madrid 09.jpg","Fiesta Celebracion Eurocopa 2024 - Madrid 12.jpg","Celebrando la cuarta Eurocopa de la selección española. Madrid, 15 de julio de 2024.jpg"]},
          {files: ["Olympiastadion Berlin Sep-2015.jpg"], names: ["berlin","england"]},
          {files: ["Nico Williams Argentina v Spain 19 July 2026-328.jpg","Nico Williams France v Spain 7.24.26-258.jpg"], names: ["williams","nico"]},
          {files: ["ColePalmervsLeicester.jpg"], names: ["palmer","equalised","equalized"]},
          {files: ["Mikel Oyarzabal France v Spain 7.24.26-161 (cropped).jpg"], names: ["oyarzabal","substitute","winner"]},
          {files: ["Luis de la Fuente.jpg"], names: ["fuente","coach"]}
        ],
        label: 'Euro 2024 Final · Berlin',
        moment: 'On 14 July 2024 in Berlin Spain beat England 2–1 in the Euro 2024 final to win a record fourth European Championship, after winning all seven of their games.',
        // The goal paragraphs, into the brief (naming scorers in the moment failed the article check).
        focus: 'Williams scored Yamal crossed Palmer Oyarzabal Cucurella Pickford minute goal',
        title: 'Seven Games, Seven Wins: Spain\'s Perfect Euro',
        teaser: 'Two years later, Spain went to the World Cup as favourites.',
        note: 'Say who scored only as the source tells it, and name Luis de la Fuente as Spain\'s coach. Leave out the referee and the crowd size.'
      },
      {
        articles: ['2026 FIFA World Cup final', 'Luis de la Fuente (footballer, born 1961)'],
        subject: 'Luis de la Fuente',
        photos: [
          {files: ["Spain World Cup Winners Argentina v Spain 19 July 2026-1.jpg","Spain World Cup Winners Argentina v Spain 19 July 2026-344.jpg","Spain World Cup winners Argentina v Spain 19 July 2026-339.jpg","Spain's celebration as 2026 World Cup champions.jpg","FIFA World Cup Trophy photo by Djuradj Vujcic.jpg"]},
          {files: ["MetLife Stadium Exterior, 2026 FIFA World Cup (June 20, 2026).jpg"], names: ["metlife","stadium"]},
          {files: ["Argentina fans Argentina v Spain 19 July 2026-063.jpg"], names: ["argentina","defending"]},
          {files: ["Emiliano Martinez Argentina v Spain 19 July 2026-269.jpg"], names: ["martinez","emiliano","keeper","goalkeeper","saves"]},
          {files: ["Enzo Fernandez Argentina v Spain 19 July 2026-050 (cropped).jpg"], names: ["fernandez","enzo","red"]},
          {files: ["Mikel Merino Argentina v Spain 19 July 2026-327.jpg"], names: ["merino"]},
          {files: ["Nico Williams Argentina v Spain 19 July 2026-196 (cropped).jpg"], names: ["williams","nico"]},
          {files: ["Ferran Torres Argentina v Spain 19 July 2026-244.jpg","Ferran Torres Argentina v Spain 19 July 2026-347.jpg"], names: ["torres","ferran"]},
          {files: ["Luis de la Fuente Argentina v Spain 19 July 2026-271 (cropped).jpg","Luis de la Fuente Argentina v Spain 19 July 2026-270.jpg"], names: ["fuente","luis","coach","manager","oldest"]}
        ],
        label: 'World Cup Final · 2026',
        moment: 'On 19 July 2026 Spain beat defending champions Argentina 1–0 after extra time in the World Cup final, with a goal from Ferran Torres.',
        title: 'The Youth Coach Who Won Everything',
        note: 'This is the last part. His article says he became the first manager to win the Nations League, the European Championship and the World Cup, and the oldest to win the World Cup: land the whole story on that in the final line.'
      }
    ]
  },
  {
    key: 'ajax-1995',
    name: 'Ajax 1995',
    parts: [
      {
        articles: ['1995 UEFA Champions League final', 'AFC Ajax', 'Bosman ruling'],
        subject: 'Ajax',
        photos: [{ article: 'Patrick Kluivert', n: 3, names: ['kluivert', 'patrick'] }, { article: 'Louis van Gaal', n: 2, names: ['gaal', 'louis'] },
          { article: 'Edgar Davids', n: 2, names: ['davids', 'edgar'] }, { article: 'Clarence Seedorf', n: 2, names: ['seedorf'] },
          { article: 'Jean-Marc Bosman', n: 1, names: ['bosman'] }],
        label: 'Ajax · 1995',
        moment: 'In 1995 Louis van Gaal\'s young Ajax side of academy graduates beat Milan 1–0 in the Champions League final with an 85th-minute goal from 18-year-old Patrick Kluivert, and after the Bosman ruling Edgar Davids left Ajax for Milan in 1996 as its first high-profile beneficiary.',
        title: 'Ajax\'s Teenagers Conquered Europe. Then They Left.'
      }
    ]
  },
  {
    key: 'rogerio-ceni',
    name: 'Rogério Ceni',
    parts: [
      {
        articles: ['Rogério Ceni'],
        subject: 'Rogério Ceni',
        photos: [{ article: 'Rogério Ceni', n: 8 }, { article: 'São Paulo FC', n: 2, names: ['paulo'] }],
        label: 'São Paulo · Goalkeeper',
        moment: 'Rogério Ceni, São Paulo\'s goalkeeper and dead-ball specialist, scored more than 100 goals, mostly from free kicks and penalties, the most by any goalkeeper in football history; his 100th was a free kick against Corinthians.',
        title: 'The Goalkeeper Who Scored More Than 100 Goals',
        note: 'The article gives both 129 and 131 as his career total. Say "more than a hundred goals" and give no total.'
      }
    ]
  },
  {
    key: 'pep-guardiola',
    name: 'How Pep Guardiola Changed Football',
    parts: [
      {
        articles: ['Pep Guardiola'],
        subject: 'Pep Guardiola',
        photos: [{ article: 'Johan Cruyff', n: 4, names: ['cruyff', 'johan'] }, { article: 'Pep Guardiola', n: 5, names: ['guardiola', 'pep'] },
          { article: 'La Masia', n: 1, names: ['masia'] }],
        label: 'Barcelona · 1990–1992',
        moment: 'Johan Cruyff turned up unannounced to watch Barcelona B, moved a young Pep Guardiola into the middle as pivot, and in 1990 Guardiola became the pivot of Cruyff\'s Dream Team that won Barcelona\'s first European Cup in 1992.',
        title: 'The Day Cruyff Saw Something in Pep Guardiola',
        teaser: 'Years later, Barcelona handed that same midfielder their first team.'
      },
      {
        articles: ['Pep Guardiola'],
        subject: 'Pep Guardiola',
        photos: [{ article: 'Pep Guardiola', n: 6, names: ['guardiola', 'pep'] }, { article: 'Lionel Messi', n: 3, names: ['messi', 'lionel'] }],
        label: 'Barcelona · 2008–2009',
        moment: 'Promoted from Barcelona B in 2008, Pep Guardiola won the continental treble in his first season and finished 2009 with a record six trophies in one calendar year, the first manager in history to do so.',
        title: 'The Rookie Manager Who Won Six Trophies in a Year',
        teaser: 'Then he left Spain, for Germany and England.'
      },
      {
        articles: ['Pep Guardiola'],
        subject: 'Pep Guardiola',
        photos: [{ article: 'Pep Guardiola', n: 7, names: ['guardiola', 'pep'] }, { article: 'Allianz Arena', n: 1, names: ['bayern', 'munich'] },
          { article: 'City of Manchester Stadium', n: 1, names: ['manchester'] }],
        label: 'Bayern Munich · Manchester City',
        moment: 'Pep Guardiola won the Bundesliga in each of his three seasons at Bayern Munich, then at Manchester City became the first manager to reach 100 points in a Premier League season and in 2023 won the club\'s first Champions League and the continental treble.',
        title: 'How Pep Guardiola Conquered Germany and England',
        note: 'This is the last part: land how he changed football in the final line.'
      }
    ]
  }
];

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'];

/** stories.json id for one part. */
const partId = (series, n) => `story-series-${series.key}${series.parts.length > 1 ? `-p${n}` : ''}`;

/**
 * The series part due today on this lane, or null: the first part, in SERIES
 * order, not yet uploaded — unless a part already went out today (one a day,
 * so "Part two is next" means tomorrow) or the part before it is not public
 * yet (a link to a private video would be dead).
 * Returns { series, part, n, prev } with prev = { id, videoId } for n > 1.
 */
function seriesPartDue(lane, now = new Date()) {
  if (!lane.series) return null;
  const base = (...p) => path.join(ROOT, lane.dataRoot, ...p);
  const stories = readJson(base('stories.json'), []);
  const ledger = readJson(base('shorts', 'uploads.json'), {});
  const today = now.toISOString().slice(0, 10);
  const posted = (id) => ledger[id]?.videoId;
  if (stories.some((s) => s.series && posted(s.id) && String(ledger[s.id].uploadedAt || s.at).slice(0, 10) === today)) return null;
  for (const series of SERIES) {
    for (let n = 1; n <= series.parts.length; n++) {
      const id = partId(series, n);
      if (posted(id)) continue;
      if (n > 1) {
        const prevId = partId(series, n - 1);
        if (ledger[prevId]?.privacyStatus !== 'public') return null;
        return { series, part: series.parts[n - 1], n, prev: { id: prevId, videoId: ledger[prevId].videoId } };
      }
      return { series, part: series.parts[0], n: 1, prev: null };
    }
  }
  return null;
}

module.exports = { SERIES, seriesPartDue, partId, NUMBER_WORDS };
