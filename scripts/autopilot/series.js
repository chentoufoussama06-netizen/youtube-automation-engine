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
        // Every photo LOOKED AT before use (2026-11-07, after the user saw a teenage
        // Vinicius and no team celebration): Marcelo and Benzema lifting the trophy,
        // the squad with both trophies, the trophy in the team bus; Courtois's
        // cathedral photo once, then him in kit; Vinicius celebrating in Real Madrid
        // kit (Copa del Rey 2023, the nearest adult photo); no Ancelotti photo exists.
        photos: [
          {files: ["Ofrenda de la Liga y la Champions-54-L.Millán (52109310918).jpg","Ofrenda de la Liga y la Champions-55-L.Millán (52109278836).jpg","Ofrenda de la Liga y la Champions-57-L.Millán (52109310843).jpg","Ofrenda de la Liga y la Champions-50-L.Millán (52109789010).jpg","Ofrenda de la Liga y la Champions-58-L.Millán (52109788725).jpg"]},
          {files: ["StadeFranceNationsLeague2018.jpg"], names: ["stade","france","paris","delayed","kickoff"]},
          {files: ["Ofrenda de la Liga y la Champions-19-L.Millán (52108254662).jpg","FC RB Salzburg versus Real Madrid (Testspiel, 7. August 2019) 03.jpg","FC RB Salzburg gegen Real Madrid (Testspiel, 7. August 2019) 17.jpg"], names: ["courtois","thibaut","saved","saves","keeper","goalkeeper"], firstOnce: 1},
          {files: ["2023 05 06 Final de la Copa del Rey - 52879242230 (cropped).jpg"], names: ["vinicius","junior","scored","goal"]},
          {files: ["Luka Modric - Ofrenda de la Liga y la Champions-56-L.Millán (52109788795) (cropped).jpg"], names: ["modric"]}
        ],
        clipTeams: ['Real Madrid'],
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
    // Also removed after looking (8 Nov): an ice-cream sign, a random night crowd,
    // Nico Williams with the World Cup trophy in the Euro part, the US president.
    // 'Luis de la Fuente.jpg' (blurry, a hand across his face) replaced after a
    // look on 8 Nov by the clear 2023 portrait and a neutral 2026 touchline one.
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
          {files: ["Luis de la Fuente Castillo - 2023 05 06 Final de la Copa del Rey 0001 (cropped).jpg","Luis de la Fuente France v Spain 7.24.26-036.jpg"], names: ["fuente","luis","coach"]},
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
          {files: ["Luis de la Fuente Castillo - 2023 05 06 Final de la Copa del Rey 0001 (cropped).jpg","Luis de la Fuente France v Spain 7.24.26-036.jpg"], names: ["fuente","luis","coach"]},
          {files: ["Joselu espanyol 2022 (cropped).jpg"], names: ["joselu","debutant","norway"]},
          {files: ["Unai Simon Argentina v Spain 19 July 2026-078 (cropped).jpg","Unai Simon France v Spain 7.24.26-118 (cropped).jpg"], names: ["simon","unai","saved","saves","penalties","shootout","keeper","goalkeeper"]},
          {files: ["UEFA EURO qualifiers Sweden vs Spain 20191015 Dani Carvajal 10 (cropped).jpg"], names: ["carvajal","chipped","chip"]}
        ],
        clipTeams: ['Spain'],   // Spain fans on the victory words, never random people
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
          {files: ["2024-07-05 UEFA Euro 2024 Fan Zone Berlin Brandenburger Tor by Sandro Halank–002.jpg","2024-07-05 UEFA Euro 2024 Fan Zone Berlin Brandenburger Tor by Sandro Halank–009.jpg"]},
          {files: ["Lamine Yamal in 2025.jpg","Lamine Yamal France v Spain 7.24.26-187.jpg"], names: ["yamal","lamine","teenager","winger"]},
          {files: ["Mikel Merino France v Spain 7.24.26-241 (cropped).jpg"], names: ["merino","header","headed"]},
          {files: ["Dani Olmo France v Spain 7.24.26-176 (cropped).jpg"], names: ["olmo"]},
          {files: ["Luis de la Fuente Castillo - 2023 05 06 Final de la Copa del Rey 0001 (cropped).jpg","Luis de la Fuente France v Spain 7.24.26-036.jpg"], names: ["fuente","coach"]}
        ],
        clipTeams: ['Spain'],   // Spain fans on the victory words, never random people
        label: 'Euro 2024 · Germany',
        moment: 'At Euro 2024 Spain won their group without conceding, knocked out hosts Germany 2–1 with a Mikel Merino header in the 119th minute, and in the semi-final against France teenager Lamine Yamal equalised from outside the box before Dani Olmo scored the winner.',
        title: 'Spain Knocked Out Germany in the 119th Minute',
        teaser: 'One game left: England, in Berlin.',
        // Open on a face and the title's promise: the 9 Nov preview opened on
        // "Fresh off their Nations League triumph..." over a Berlin crowd.
        // The 9 Nov re-render had the semi "ticking toward extra time": it was
        // won 2-1 in normal time, Yamal's equaliser then Olmo's winner.
        note: 'Open on the 119th-minute header: name Mikel Merino and hosts Germany in the first sentence. The semi-final against France was won 2–1 in normal time: Yamal equalised, then Dani Olmo scored the winner; tell both, and that Spain were through to the final. Merino and Olmo won the 2019 under-21 title under de la Fuente: his own youth players decided both games. Do not tell the final.'
      },
      {
        articles: ['UEFA Euro 2024 final'],   // alone, so both goal paragraphs fit the brief
        subject: 'Spain',
        photos: [
          {files: ["Fiesta Celebracion Eurocopa 2024 - Madrid 03.jpg","Fiesta Celebracion Eurocopa 2024 - Madrid 06.jpg","Fiesta Celebracion Eurocopa 2024 - Madrid 09.jpg","Celebrando la cuarta Eurocopa de la selección española. Madrid, 15 de julio de 2024.jpg"]},
          {files: ["Olympiastadion Berlin Sep-2015.jpg"], names: ["berlin","england"]},
          {files: ["Nico Williams France v Spain 7.24.26-258.jpg"], names: ["williams","nico"]},
          {files: ["ColePalmervsLeicester.jpg"], names: ["palmer","equalised","equalized"]},
          {files: ["Mikel Oyarzabal France v Spain 7.24.26-161 (cropped).jpg"], names: ["oyarzabal","substitute","winner"]},
          {files: ["Luis de la Fuente Castillo - 2023 05 06 Final de la Copa del Rey 0001 (cropped).jpg","Luis de la Fuente France v Spain 7.24.26-036.jpg"], names: ["fuente","coach"]}
        ],
        clipTeams: ['Spain'],   // Spain fans on the victory words, never random people
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
          {files: ["Spain World Cup Winners Argentina v Spain 19 July 2026-1.jpg","Spain World Cup Winners Argentina v Spain 19 July 2026-344.jpg","Spain World Cup winners Argentina v Spain 19 July 2026-339.jpg","FIFA World Cup Trophy photo by Djuradj Vujcic.jpg"]},
          {files: ["MetLife Stadium Exterior, 2026 FIFA World Cup (June 20, 2026).jpg"], names: ["metlife","stadium"]},
          {files: ["Argentina fans Argentina v Spain 19 July 2026-063.jpg"], names: ["argentina","defending"]},
          {files: ["Emiliano Martinez Argentina v Spain 19 July 2026-269.jpg"], names: ["martinez","emiliano","keeper","goalkeeper","saves"]},
          {files: ["Enzo Fernandez Argentina v Spain 19 July 2026-050 (cropped).jpg"], names: ["fernandez","enzo","red"]},
          {files: ["Mikel Merino Argentina v Spain 19 July 2026-327.jpg"], names: ["merino"]},
          {files: ["Nico Williams Argentina v Spain 19 July 2026-196 (cropped).jpg"], names: ["williams","nico"]},
          {files: ["Ferran Torres Argentina v Spain 19 July 2026-244.jpg","Ferran Torres Argentina v Spain 19 July 2026-347.jpg"], names: ["torres","ferran"]},
          {files: ["Luis de la Fuente Argentina v Spain 19 July 2026-271 (cropped).jpg","Luis de la Fuente Argentina v Spain 19 July 2026-270.jpg"], names: ["fuente","luis","coach","manager","oldest"]}
        ],
        clipTeams: ['Spain'],   // Spain fans on the victory words, never random people
        label: 'World Cup Final · 2026',
        moment: 'On 19 July 2026 Spain beat defending champions Argentina 1–0 after extra time in the World Cup final, with a goal from Ferran Torres.',
        // States the payoff (the old "The Youth Coach Who Won Everything"
        // named nobody); the first lines must now say Spain and the World Cup.
        title: 'Spain\'s Youth Coach Won the World Cup',
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
  // 2026-11-23: series parts are where Football Files' subscribers come from
  // (13 parts in 28 days: 28 subs, 2.2 a post, against 0.8 for one-off
  // stories; Benzema Part 1: 2,912 views, +15), and the megastar slot is its
  // best one-off format. So a megastar's life in three acts goes first.
  // Every moment is a paraphrase of lines in the Lionel Messi article.
  {
    key: 'messi-too-small',
    // held until a cloud preview's photos are checked (set to false then)
    held: true,
    name: 'Lionel Messi: Too Small to Play',
    parts: [
      {
        articles: ['Lionel Messi'],
        subject: 'Lionel Messi',
        // No free photo of Messi before 2005 exists, so the part runs to his
        // debut at 16 and the earliest photos (2005, Barcelona) carry it.
        photos: [{ files: ['File:Leo messi barce 2005.jpg'] }, { files: ['File:Barca team.jpg'], names: ['debut', 'ronaldinho', 'first team'] },
          { article: 'Camp Nou', n: 3, names: ['camp nou', 'barcelona'], anyYear: true }],
        label: 'Rosario · Barcelona · 1997–2003',
        moment: 'At the age of 10 Lionel Messi was diagnosed with a growth hormone deficiency; his father\'s health insurance covered only two years of the therapy and Newell\'s reneged on their promise to help, so at 13 he had a trial at Barcelona, where Carles Rexach wrote him a contract on a paper napkin, and at 16 he made his first-team debut in a friendly against FC Porto in November 2003.',
        title: 'Too Small to Play, Signed on a Napkin',
        teaser: 'Years later, as Argentina\'s captain, he lost three finals in three years.'
      },
      {
        articles: ['Lionel Messi'],
        subject: 'Lionel Messi',
        // 2014 final (Agência Brasil); no free photos of the 2015/2016 finals.
        photos: [{ files: ['File:Germany and Argentina face off in the final of the World Cup 2014 -2014-07-13 (24) (cropped).jpg',
          'File:Germany and Argentina face off in the final of the World Cup 2014 03.jpg', 'File:Germany and Argentina face off in the final of the World Cup 2014 15.jpg'] },
        { files: ['File:Germany and Argentina face off in the final of the World Cup 2014 -2014-07-13 (44).jpg',
          'File:Germany and Argentina face off in the final of the World Cup 2014 -2014-07-13 (16).jpg'], names: ['germany', 'world cup final'] }],
        label: 'Argentina · 2014–2016',
        moment: 'As Argentina captain Lionel Messi lost the 2014 World Cup final to Germany, the 2015 Copa América final to Chile and the 2016 Copa América Centenario final to Chile again; losing three finals in three consecutive years caused him to retire from international football, and a bronze statue of him was put up in Buenos Aires to convince him to return.',
        title: 'Messi Lost Three Finals in a Row, Then Quit',
        teaser: 'A nationwide campaign brought him back.'
      },
      {
        articles: ['Lionel Messi'],
        subject: 'Lionel Messi',
        photos: [{ files: ['File:Lionel Messi WC2022.jpg', 'File:Lionel-Messi-Argentina-2022-FIFA-World-Cup (cropped).jpg', 'File:Celebración del partido Argentina-Croacia.jpg'] },
        { files: ['File:Argentina 3-3 Francia - Copa Mundial 2022 - Messi patea un penal.jpg', 'File:2022 wc final 03.jpg'], names: ['france', 'final', 'twice'] }],
        label: 'Argentina · 2021–2022',
        moment: 'Lionel Messi ended Argentina\'s 28-year trophy drought by beating Brazil in the 2021 Copa América final, and at the 2022 FIFA World Cup he scored twice in the final against France to win Argentina\'s first World Cup in 36 years, becoming the first player to win the Golden Ball twice.',
        title: 'Messi Finally Won It All for Argentina',
        note: 'This is the last part: land the whole journey, from the boy too small to play, in the final line.'
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
  },
  // Ancient Untold (lane "Ancient History"), from 2026-11-23. Its series parts
  // brought 1-4 subscribers each (Crassus Part 2 1,120 views +3, Part 3 905 +4)
  // and it had none since 11 Nov, the weeks its views fell 13.7K, 6.2K, 3.4K.
  // Spartacus ends on Crassus, the man behind its best short (Carrhae, 1,551).
  // Photos are hand-picked Commons files, each looked at on 23 Nov (statues,
  // mosaics, a 19th-century drawing, the ruins and the road themselves; no
  // film stills, no modern people or ships).
  {
    key: 'spartacus',
    lane: 'Ancient History',
    name: 'Spartacus',
    parts: [
      {
        articles: ['Spartacus'],
        subject: 'Spartacus',
        photos: [
          { files: ['File:Spartacus-Vincenzo Vela-MAHG 1896-0007-IMG 8680.JPG', 'File:Spartacus - Denis Foyatier - statue in Louvre.jpg',
            'File:Gladiators, fragment, Roman, 300-400 AD, marble and limestone mosaic - Galleria Borghese - Rome, Italy - DSC04941.jpg'] },
          { files: ['File:Borghese gladiator mosaic scene.jpg', 'File:Retiarius defeats secutor from the Borghese gladiator mosaic.jpg'], names: ['gladiator', 'gladiators', 'school'] },
          { files: ['File:Anfiteatro Campano (Santa Maria di Capua Vetere) 19.jpg'], names: ['capua'] },
          { files: ['File:Frank Short - Vesuvius from the Bay of Naples - B1986.30.63 - Yale Center for British Art.jpg'], names: ['vesuvius', 'volcano'] }
        ],
        label: 'Capua · 73 BC',
        moment: 'In 73 BC Spartacus and about 70 other gladiators seized kitchen utensils and fought their way out of the gladiatorial school near Capua; besieged on Mount Vesuvius by the praetor Gaius Claudius Glaber, they climbed down the steep side of the volcano on ropes made from vines and attacked the Roman camp from the rear, killing most of the militia.',
        title: '70 Gladiators Broke Out With Kitchen Tools',
        teaser: 'Soon some 70,000 people had joined him.',
        note: 'Say "kitchen utensils", as the source does: it never says what kind.'
      },
      {
        articles: ['Spartacus', 'Third Servile War'],
        subject: 'Spartacus',
        photos: [
          { files: ['File:Le Serment de Spartacus by Louis-Ernest Barrias, Jardin des Tuileries 01.jpg', 'File:Spartacus-Vincenzo Vela-MAHG 1896-0007-IMG 8686.JPG',
            'File:Spartacus, marble sculpture of Denis Foyatier (1830), Louvre Museum (8269334205).jpg'] },
          { files: ['File:Gladiators, fragment, Roman, 300-400 AD, marble and limestone mosaic - Galleria Borghese - Rome, Italy - DSC04941.jpg'], names: ['slaves', 'herdsmen', 'shepherds'] },
          { files: ['File:Head of Marcus Licinius Crassus, middle of 1st century BC, from Italy, Moi, Auguste, Empereur de Rome exhibition, Grand Palais, Paris - 14649017884.jpg'], names: ['crassus', 'wealthiest'] }
        ],
        label: 'Italy · 72–71 BC',
        moment: 'Spartacus\'s forces defeated several Roman military units and swelled to an estimated 70,000; alarmed, the Senate gave the war to Marcus Licinius Crassus, the wealthiest man in Rome and the only volunteer, who took eight legions and revived decimation, killing one in ten of his own men to make them fear him more than the enemy.',
        title: 'Rome\'s Richest Man Killed His Own Soldiers',
        teaser: 'Then Crassus went after Spartacus himself.'
      },
      {
        articles: ['Spartacus', 'Third Servile War'],
        subject: 'Spartacus',
        photos: [
          { files: ['File:Tod des Spartacus by Hermann Vogel.jpg', 'File:Spartacus-Vincenzo Vela-MAHG 1896-0007-IMG 8680.JPG'] },
          { files: ['File:Head of Marcus Licinius Crassus, middle of 1st century BC, from Italy, Moi, Auguste, Empereur de Rome exhibition, Grand Palais, Paris - 14649017884.jpg'], names: ['crassus'] },
          { files: ['File:Appian Way.jpg', 'File:Via appia.jpg'], names: ['appian', 'road', 'capua'] }
        ],
        label: 'Lucania · 71 BC',
        moment: 'In 71 BC, with Pompey\'s legions marching south, Spartacus\'s army threw its full strength against Crassus\'s legions and was utterly defeated; Spartacus was presumed killed in the final battle, although his body was never found, and 6,000 captured rebels were crucified along the Appian Way from Rome to Capua.',
        title: 'Spartacus Vanished. 6,000 Were Crucified.',
        note: 'This is the last part. Never describe the crucifixions in detail: say the number and the road, nothing more.'
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
// `failed(id)`: a part that keeps failing its checks gives up its series, and
// the next series starts. Ajax 1995 Part 1 had only 3 usable photos and took
// Football Files' first slot in every run from 19 to 23 Nov.
function seriesPartDue(lane, now = new Date(), { failed = () => false } = {}) {
  if (!lane.series) return null;
  const base = (...p) => path.join(ROOT, lane.dataRoot, ...p);
  const stories = readJson(base('stories.json'), []);
  const ledger = readJson(base('shorts', 'uploads.json'), {});
  const today = now.toISOString().slice(0, 10);
  const posted = (id) => ledger[id]?.videoId;
  // A part taken off a schedule to be redone (post-series --replace) keeps its
  // date: it is not due before the day it was going out.
  const reservedUntil = (id) => Math.max(0, ...Object.entries(ledger)
    .filter(([k, v]) => k.startsWith(`${id}~superseded`) && v.wasScheduledFor)
    .map(([, v]) => Date.parse(v.wasScheduledFor) || 0));
  if (stories.some((s) => s.series && posted(s.id) && String(ledger[s.id].uploadedAt || s.at).slice(0, 10) === today)) return null;
  // A series without `lane` is Football Files' (every series before 23 Nov).
  for (const series of SERIES.filter((s) => !s.held && (s.lane || 'Football Files') === lane.name)) {
    for (let n = 1; n <= series.parts.length; n++) {
      const id = partId(series, n);
      if (posted(id)) continue;
      if (failed(id)) break;   // this series is given up; try the next one
      if (reservedUntil(id) > now.getTime()) return null;
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
