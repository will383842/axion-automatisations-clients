// Données interdites à l'import (T2-47, C-060) : on regarde les NOMS de colonnes, jamais le contenu. Refuser = ne pas stocker ; rien d'existant n'est purgé.
import { ErreurRegleMetier, type Requeteur } from "../instances/activer.ts";
import { CATEGORIES, type Categorie, EXCEPTIONS, MOTIFS, MOTS_VIDES } from "./motifs-interdits.ts";

export const MOTIF_DONNEES_INTERDITES = "donnees_interdites";
export type ColonneInterdite = { colonne: string; categorie: Categorie };

// NFKD (pleine largeur, accents), séparation des mots collés en casse mixte (« numSecu »), minuscules, tout ce qui n'est pas lettre ou chiffre devient `_`,
// petits mots vides retirés : « Numéro de Sécurité-Sociale » → « numero_securite_sociale ».
const normaliser = (nom: string) =>
  nom
    .normalize("NFKD")
    .replace(/[\p{M}\p{Cf}]/gu, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .split("_")
    .filter((m) => m && !MOTS_VIDES.includes(m))
    .join("_");

// Égalité de mots, avec le pluriel en « s » accepté (« maladies » = « maladie »).
const memeMot = (mot: string, motif: string) => mot === motif || mot === `${motif}s`;

// Un motif court doit être un ou plusieurs MOTS entiers (« nir » n'est pas dans « senior ») ; un motif long (8 lettres et plus) est aussi cherché collé (« numerosecuritesociale »).
function correspond(colonne: string, motif: string): boolean {
  const mots = colonne.split("_");
  const m = motif.split("_");
  for (let i = 0; i + m.length <= mots.length; i++) if (m.every((x, j) => memeMot(mots[i + j] as string, x))) return true;
  const colle = motif.replace(/_/g, "");
  return colle.length >= 8 && colonne.replace(/_/g, "").includes(colle);
}

const estException = (colonne: string) => EXCEPTIONS.some((e) => colonne === e || colonne === `${e}s`);

export function detecter(colonnes: string[]): ColonneInterdite[] {
  const trouvees: ColonneInterdite[] = [];
  for (const colonne of colonnes) {
    const n = normaliser(colonne);
    if (estException(n)) continue;
    const categorie = CATEGORIES.find((c) => MOTIFS[c].some((m) => correspond(n, m)));
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
