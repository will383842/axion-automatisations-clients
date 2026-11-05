// Données interdites à l'import (T2-47, C-060) : on regarde les NOMS de colonnes, jamais le contenu. Refuser = ne pas stocker ; rien d'existant n'est purgé.
// LIMITE ASSUMÉE : une garde par noms ne peut pas être exhaustive. C'est une AIDE (refus des noms évidents), pas un contrôle de contenu : une colonne « note » pleine d'IBAN passe.
// Le contrôle de contenu reste une dette (LOT2-dette-T2-47b-contenu dans spec/preuves.md, fiche T2-52).
// Règles : motifs courts (pin, cb, secu, nss, ssn, rib, bic, nir, cvv, cvc, mdp, pwd) seulement en MOTS entiers ou en formes collées connues ; motifs longs aussi collés ; « insee » et « compte_bancaire »
// seulement s'ils sont le nom entier ; écriture « leet » lue en plus du nom brut ; toute lettre hors latin (après NFKD et table de ressemblances) sans autre motif trouvé : refus « caracteres_non_latins ».
// Faux positifs connus et acceptés : voir le corps de la PR (mots seuls pin, cb, bic, secret, token, swift, jeton, casier, medical ; noms grecs, cyrilliques ou idéographiques).
import { ErreurRegleMetier, type Requeteur } from "../instances/activer.ts";
import { AFFIXES, CATEGORIES, COLLES, CONFUSABLES, type Categorie, ENTIER_SEUL, EXCEPTIONS, LATINES_ETENDUES, LEET, MOTIFS, MOTS_VIDES, SANS_PLURIEL } from "./motifs-interdits.ts";

export const MOTIF_DONNEES_INTERDITES = "donnees_interdites";
export type ColonneInterdite = { colonne: string; categorie: Categorie };

// Racine d'un mot, utilisée seulement pour comparer les EXCEPTIONS (des deux côtés) : sans chiffres ni « s » final.
const racine = (mot: string) => mot.replace(/\d+$/, "").replace(/s$/, "");

// NFKD (pleine largeur, accents), caractères invisibles retirés, lettres grecques ou cyrilliques ressemblantes remplacées par la lettre latine,
// séparation des mots collés en casse mixte (« PassWord », « IBANClient »), minuscules ; tout ce qui n'est pas une lettre (chiffres compris) sépare les mots.
// La casse est lue AVANT toute suppression de lettre : aucune racine n'est retirée ici (« password » ne devient jamais « pas »).
const mots = (nom: string): { mots: string[]; nonLatin: boolean } => {
  const net = nom
    .normalize("NFKD")
    .replace(/[\p{M}\p{Cf}\p{Cc}]/gu, "")
    .replace(/[\u0131\u0370-\u03ff\u0400-\u04ff\u0500-\u052f]/g, (c) => CONFUSABLES[c] ?? c)
    .replace(/[œŒæÆßøØłŁđĐþÞðÐ]/g, (c) => LATINES_ETENDUES[c] ?? c);
  return {
    // Une lettre hors a-z restant ici (petites capitales, lettres rares, idéogrammes) : le nom est refusé en dernier recours, sans deviner son sens.
    nonLatin: /(?![a-zA-Z])\p{L}/u.test(net),
    mots: net
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter(Boolean),
  };
};

// Nom en « leet » (@→a, 5→s, 0→o, 1→i, 3→e, 4→a, $→s), ou null s'il n'y a rien à remplacer. La lettre posée prend la casse du voisinage (« 1BAN » → « IBAN »).
const leet = (nom: string): string | null => {
  if (!/[@$013-5]/.test(nom)) return null;
  const sansMinuscule = !/[a-z]/.test(nom);
  const maj = (c: string | undefined) => c !== undefined && /\p{Lu}/u.test(c);
  return nom.replace(/[@$013-5]/g, (c, i: number) => {
    const l = LEET[c] as string;
    return sansMinuscule || maj(nom[i - 1]) || maj(nom[i + 1]) ? l.toUpperCase() : l;
  });
};

const egal = (mot: string, m: string) => mot === m || (mot === `${m}s` && !SANS_PLURIEL.includes(m));

const colle = (motif: string) => motif.split("_").join("");
const JETONS_MOTIFS = new Set(CATEGORIES.flatMap((c) => MOTIFS[c].filter((m) => !ENTIER_SEUL.includes(m)).map(colle)));
const JETONS = [...new Set([...JETONS_MOTIFS, ...AFFIXES])].sort((x, y) => y.length - x.length);

// Vrai si `texte` se découpe entièrement en jetons connus (motifs ou affixes, avec « s » final facultatif) dont le motif `cible`.
function decoupable(texte: string, cible: string): boolean {
  const atteint = new Set<string>(["0:0"]);
  for (let i = 0; i < texte.length; i++) {
    for (const utilise of [0, 1]) {
      if (!atteint.has(`${i}:${utilise}`)) continue;
      for (const j of JETONS) {
        for (const fin of SANS_PLURIEL.includes(j) ? [""] : ["", "s"]) {
          const t = j + fin;
          if (texte.startsWith(t, i)) atteint.add(`${i + t.length}:${utilise || (j === cible ? 1 : 0)}`);
        }
      }
    }
  }
  return atteint.has(`${texte.length}:1`);
}

// Un motif court (pin, cb, secu, nss, ssn, rib, bic, nir, cvv, cvc, mdp, pwd) doit être un ou plusieurs MOTS entiers (« nir » n'est pas dans « senior », « secu » n'est pas dans « lesecu ») ; un motif long (8 lettres et plus) est aussi cherché collé (« numerosecuritesociale »).
// Les motifs de COLLES (« iban ») sont aussi cherchés en début ou en fin du nom collé (« ibanclient », « clientiban », « i b a n ») ;
// tout motif est cherché dans un mot collé qui se découpe en motif + affixes connus, dans les deux sens (« ribclient », « moncodenirfr », « numsecuclient »).
function correspond(utiles: string[], tous: string[], motif: string): boolean {
  const m = motif.split("_");
  if (ENTIER_SEUL.includes(motif)) return m.length === utiles.length && m.every((x, j) => egal(utiles[j] as string, x));
  for (let i = 0; i + m.length <= utiles.length; i++) if (m.every((x, j) => egal(utiles[i + j] as string, x))) return true;
  const c = colle(motif);
  const nomColle = tous.join(""); // sans retrait des petits mots : « i b a n » contient le mot « n »
  if (c.length >= 8 && nomColle.includes(c)) return true;
  if (COLLES.includes(motif) && nomColle.startsWith(c)) return true;
  return [...tous, nomColle].some((t) => t.length >= c.length && decoupable(t, c));
}

const normaliserException = (nom: string) => mots(nom).mots.map(racine).join("_");
const exceptionsNormalisees = EXCEPTIONS.map(normaliserException);
const estException = (nom: string) => exceptionsNormalisees.includes(normaliserException(nom));

export function detecter(colonnes: string[]): ColonneInterdite[] {
  const trouvees: ColonneInterdite[] = [];
  for (const colonne of colonnes) {
    if (estException(colonne)) continue;
    const brut = mots(colonne);
    const variante = leet(colonne);
    const lectures = variante === null ? [brut.mots] : [brut.mots, mots(variante).mots];
    const categorie =
      CATEGORIES.find((c) => c !== "caracteres_non_latins" && lectures.some((tous) => {
        const utiles = tous.filter((m) => !MOTS_VIDES.includes(m));
        return MOTIFS[c].some((m) => correspond(utiles, tous, m));
      })) ?? (brut.nonLatin ? "caracteres_non_latins" : undefined);
    if (categorie) trouvees.push({ colonne, categorie });
  }
  return trouvees;
}

// Chaque nom recopié dans le message est borné à 60 caractères (nom de colonne venant d'un fichier non fiable : pas de message géant ni de contenu glissé dans un nom). La liste structurée garde le nom entier.
const borner = (nom: string) => (nom.length > 60 ? `${nom.slice(0, 59)}…` : nom);

export class ErreurDonneesInterdites extends ErreurRegleMetier {
  constructor(readonly colonnes: ColonneInterdite[]) {
    super(MOTIF_DONNEES_INTERDITES);
    this.message = `Ce fichier contient des colonnes de données interdites (${colonnes.map((c) => `${borner(c.colonne)} : ${c.categorie}`).join(" ; ")}). Retirez-les puis recommencez : rien n'a été enregistré.`;
  }
}

export type VerdictImport = { accepte: true } | { accepte: false; erreur: ErreurDonneesInterdites };

// À appeler dans la transaction de la base du client, avant tout stockage. `acteur` est obligatoire : aucun repli sur un acteur par défaut.
// Un refus est RENDU (verdict), jamais levé : la trace du refus est écrite dans la transaction de l'appelant, qui doit la VALIDER (COMMIT) puis renvoyer `verdict.erreur`.
// Lever ici ferait annuler la trace par le ROLLBACK de l'appelant. Appelée par importer.ts ; la route HTTP reste à brancher (voir ESCALADE de la fiche T2-47b).
export async function verifierImport(client: Requeteur, acteur: string, colonnes: string[]): Promise<VerdictImport> {
  if (!acteur.trim()) throw new Error("verifierImport : acteur obligatoire");
  const trouvees = detecter(colonnes);
  if (trouvees.length === 0) return { accepte: true };
  // Trace sans contenu : seulement les catégories, dans l'ordre de la liste fermée.
  const categories = CATEGORIES.filter((c) => trouvees.some((t) => t.categorie === c));
  await client.query("INSERT INTO trace.evenements (qui, quoi, objet) VALUES ($1, 'import', $2)", [acteur, `refus:${MOTIF_DONNEES_INTERDITES}:${categories.join(",")}`]);
  return { accepte: false, erreur: new ErreurDonneesInterdites(trouvees) };
}
