// Données interdites à l'import (T2-47, C-060) : on regarde les NOMS de colonnes, jamais le contenu. Refuser = ne pas stocker ; rien d'existant n'est purgé.
import { ErreurRegleMetier, type Requeteur } from "../instances/activer.ts";
import { CATEGORIES, type Categorie, MOTIFS } from "./motifs-interdits.ts";

export const MOTIF_DONNEES_INTERDITES = "donnees_interdites";
export type ColonneInterdite = { colonne: string; categorie: Categorie };

// Minuscules, sans accents, tout ce qui n'est pas lettre ou chiffre devient `_` : « Numéro de Sécurité-Sociale » → « numero_de_securite_sociale ».
const normaliser = (nom: string) => nom.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// Un motif court doit être un ou plusieurs MOTS entiers (« nir » n'est pas dans « senior ») ; un motif long (8 lettres et plus) est aussi cherché collé (« numerosecuritesociale »).
function correspond(colonne: string, motif: string): boolean {
  const mots = colonne.split("_");
  const m = motif.split("_");
  for (let i = 0; i + m.length <= mots.length; i++) if (m.every((x, j) => mots[i + j] === x)) return true;
  const colle = motif.replace(/_/g, "");
  return colle.length >= 8 && colonne.replace(/_/g, "").includes(colle);
}

export function detecter(colonnes: string[]): ColonneInterdite[] {
  const trouvees: ColonneInterdite[] = [];
  for (const colonne of colonnes) {
    const n = normaliser(colonne);
    const categorie = CATEGORIES.find((c) => MOTIFS[c].some((m) => correspond(n, m)));
    if (categorie) trouvees.push({ colonne, categorie });
  }
  return trouvees;
}

export class ErreurDonneesInterdites extends ErreurRegleMetier {
  constructor(readonly colonnes: ColonneInterdite[]) {
    super(MOTIF_DONNEES_INTERDITES);
    this.message = `Ce fichier contient des colonnes de données interdites (${colonnes.map((c) => `${c.colonne} : ${c.categorie}`).join(" ; ")}). Retirez-les puis recommencez : rien n'a été enregistré.`;
  }
}

// À appeler dans la transaction de la base du client, avant tout stockage. `acteur` est obligatoire : aucun repli sur un acteur par défaut.
export async function verifierImport(client: Requeteur, acteur: string, colonnes: string[]): Promise<void> {
  if (!acteur.trim()) throw new Error("verifierImport : acteur obligatoire");
  const trouvees = detecter(colonnes);
  if (trouvees.length === 0) return;
  // Trace sans contenu : seulement les catégories, dans l'ordre de la liste fermée.
  const categories = CATEGORIES.filter((c) => trouvees.some((t) => t.categorie === c));
  await client.query("INSERT INTO trace.evenements (qui, quoi, objet) VALUES ($1, 'import', $2)", [acteur, `refus:${MOTIF_DONNEES_INTERDITES}:${categories.join(",")}`]);
  throw new ErreurDonneesInterdites(trouvees);
}
