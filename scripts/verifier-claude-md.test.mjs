// [C-392] Contrôle de CLAUDE.md. Script Node simple (T0-02 pas encore fusionnée).
// Lancer : node scripts/verifier-claude-md.test.mjs
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const chemin = join(racine, 'CLAUDE.md');
const echecs = [];
const verifier = (nom, ok) => { if (!ok) echecs.push(nom); console.log(`${ok ? 'OK ' : 'KO '} ${nom}`); };

const existe = existsSync(chemin);
verifier('[C-392] CLAUDE.md existe', existe);
const texte = existe ? readFileSync(chemin, 'utf8') : '';
const lignes = texte.split('\n');
if (lignes.at(-1) === '') lignes.pop();
verifier('[C-392] CLAUDE.md fait au plus 150 lignes', existe && lignes.length <= 150);

const titres = ['Ce qu\'est le dépôt', 'Interdits absolus', 'Consignes de routine', 'Méthode', 'Contrats', 'Commandes', 'Le texte des exigences', 'Carte des dossiers'];
titres.forEach((t, i) => {
  verifier(`[C-392] titre ${i + 1} présent : ${t}`, lignes.some((l) => /^## /.test(l) && l.includes(t)));
});

verifier('[C-392] aucun symbole €', !texte.includes('€'));
verifier('[C-392] aucune adresse IPv4', !/\b\d{1,3}(\.\d{1,3}){3}\b/.test(texte));
const arobases = [...texte.matchAll(/\S*@\S*/g)].map((m) => m[0]);
verifier('[C-392] « @ » seulement avec exemple.fr ou .test', arobases.every((a) => /@[\w.-]*exemple\.fr|@[\w.-]*\.test/.test(a)));

if (echecs.length) { console.error(`\n${echecs.length} échec(s)`); process.exit(1); }
console.log('\nTout est vert');
