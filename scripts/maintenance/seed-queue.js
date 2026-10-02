// Seeds data/queue.json with a month of topics.
//
// Existing jobs are preserved: re-running only appends topics whose id is not
// already present, so the file can be edited by hand and topped up later.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const QUEUE_PATH = process.env.QUEUE_PATH || path.join(__dirname, '..', '..', 'data', 'queue.json');

// Deliberately weighted away from the most-covered tragedies. Research on the
// niche is explicit that growth comes from underreported stories told well, not
// from re-covering cases that already have a hundred videos in every language.
const TOPICS = [
  ['sala', "La disparition d'Emiliano Sala", "Le transfert record termine au fond de la Manche, et ce que le rapport officiel a etabli sur ce vol.", ['Sala', 'Nantes', 'Cardiff']],
  ['escobar', "Le meurtre d'Andres Escobar", "Dix jours apres son but contre son camp, le defenseur colombien est abattu a Medellin.", ['Escobar', 'Colombie', '1994']],
  ['heysel', "Le drame du Heysel", "Trente-neuf morts avant la finale, et un match joue quand meme.", ['Heysel', 'Bruxelles', '1985']],
  ['superga', "La tragedie de Superga", "L'avion du Grand Torino s'ecrase sur une colline en 1949.", ['Superga', 'Torino', '1949']],
  ['munich', "La catastrophe aerienne de Munich", "Les Busby Babes de Manchester United decimes sur une piste enneigee en 1958.", ['Munich', 'United', '1958']],
  ['foe', "La mort de Marc-Vivien Foe", "Le milieu camerounais s'effondre en plein match de Coupe des Confederations 2003.", ['Foe', 'Cameroun', '2003']],
  ['puerta', "La derniere titularisation d'Antonio Puerta", "Le lateral du Sevilla FC s'effondre a trois reprises en 2007.", ['Puerta', 'Sevilla', '2007']],
  ['chapecoense', "Le vol de Chapecoense", "Une equipe bresilienne entiere disparait en route vers la finale, 2016.", ['Chapecoense', 'Bresil', '2016']],
  ['enke', "Le silence de Robert Enke", "Le gardien allemand cachait sa depression depuis des annees.", ['Enke', 'Allemagne', 'depression']],
  ['bochini', "L'affaire des paris de Calciopoli", "Le scandale qui a fait descendre la Juventus en Serie B.", ['Calciopoli', 'Juventus', 'Serie B']],
  ['hillsborough', "Hillsborough et les 97 victimes", "Comment la verite a mis vingt-sept ans a sortir.", ['Hillsborough', 'Liverpool', '1989']],
  ['maradona-mort', "Les derniers jours de Diego Maradona", "L'enquete sur les soins recus avant sa mort en 2020.", ['Maradona', 'Argentine', '2020']],
  ['bosman', "L'arret Bosman", "Comment un joueur belge inconnu a change le football europeen pour toujours.", ['Bosman', 'transfert', 'CJUE']],
  ['zamalek', "Le drame de Port-Said", "Soixante-quatorze morts dans un stade egyptien en 2012.", ['Port-Said', 'Egypte', '2012']],
  ['garrincha', "La chute de Garrincha", "Le genie bresilien mort dans la misere a quarante-neuf ans.", ['Garrincha', 'Bresil', 'alcool']]
];

const existing = fs.existsSync(QUEUE_PATH)
  ? JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'))
  : { topics: [] };

const known = new Set(existing.topics.map(t => t.id));
let added = 0;

for (const [id, topic, angle, keywords] of TOPICS) {
  if (known.has(id)) continue;
  existing.topics.push({
    id,
    topic,
    angle,
    keywords,
    contentType: 'Story',
    status: 'pending',
    attempts: 0,
    queuedAt: new Date().toISOString()
  });
  added++;
}

fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
fs.writeFileSync(QUEUE_PATH, JSON.stringify(existing, null, 2));

const pending = existing.topics.filter(t => t.status === 'pending').length;
console.log(`Added ${added} topic(s). Queue: ${existing.topics.length} total, ${pending} pending.`);
console.log(QUEUE_PATH);
