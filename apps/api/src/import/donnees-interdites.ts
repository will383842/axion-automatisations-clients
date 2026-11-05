// Données interdites à l'import (T2-47, C-060) : on regarde les NOMS de colonnes, jamais le contenu. Refuser = ne pas stocker ; rien d'existant n'est purgé.
import { ErreurRegleMetier, type Requeteur } from "../instances/activer.ts";
import { CATEGORIES, COLLES, type Categorie, EXCEPTIONS, MOTIFS, MOTS_VIDES } from "./motifs-interdits.ts";

export const MOTIF_DONNEES_INTERDITES = "donnees_interdites";
export type ColonneInterdite = { colonne: string; categorie: Categorie };

// Racine d'un mot : sans chiffres en fin de mot ni « s » final (« IBANs », « iban2 », « IBAN1 » → « iban »).
const racine = (mot: string) => mot.replace(/\d+$/, "").replace(/s$/, "");

// NFKD (pleine largeur, accents), caractères invisibles retirés, séparation des mots collés en casse mixte (« numSecu »), minuscules, tout ce qui n'est pas lettre ou chiffre devient `_`,
// petits mots vides retirés, chaque mot ramené à sa racine : « Numéro de Sécurité-Sociale » → « numero_securite_sociale ».
const normaliser = (nom: string, sansVides = true) =>
  nom
    .normalize("NFKD")
    .replace(/[\p{M}\p{Cf}\p{Cc}]/gu, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .split("_")
    .filter((m) => m && !(sansVides && MOTS_VIDES.includes(m)))
    .map(racine)
    .filter(Boolean)
    .join("_");

// Un motif court doit être un ou plusieurs MOTS entiers (« nir » n'est pas dans « senior ») ; un motif long (8 lettres et plus) est aussi cherché collé (« numerosecuritesociale »).
// Les motifs de COLLES (« iban ») sont aussi cherchés en début ou en fin du nom collé (« ibanclient », « clientiban », « i b a n »).
function correspond(colonne: string, motif: string, brut: string): boolean {
  const mots = colonne.split("_");
  const m = motif.split("_").map(racine);
  for (let i = 0; i + m.length <= mots.length; i++) if (m.every((x, j) => mots[i + j] === x)) return true;
  const colle = m.join("");
  const nomColle = brut.split("_").join(""); // sans retrait des petits mots : « i b a n » contient le mot « n »
  if (colle.length >= 8 && nomColle.includes(colle)) return true;
  return COLLES.includes(motif) && (nomColle.startsWith(colle) || nomColle.endsWith(colle));
}

const exceptionsNormalisees = EXCEPTIONS.map((e) => e.split("_").map(racine).join("_"));
const estException = (colonne: string) => exceptionsNormalisees.includes(colonne);

export function detecter(colonnes: string[]): ColonneInterdite[] {
  const trouvees: ColonneInterdite[] = [];
  for (const colonne of colonnes) {
    const n = normaliser(colonne);
    if (estException(n)) continue;
    const categorie = CATEGORIES.find((c) => MOTIFS[c].some((m) => correspond(n, m, normaliser(colonne, false))));
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
