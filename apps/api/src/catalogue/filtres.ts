import { z } from "zod";
import { statutAutomatisation, statutVersion, visibiliteAutomatisation } from "../db/schema/catalogue.js";
import { ErreurApi } from "../plugins/erreurs.js";

// Filtres, tri et curseur de la liste du catalogue (T3-40a, B-532, C-686). Tout est jugé CÔTÉ SERVEUR ; ce fichier fixe la forme de la demande et l'ORDRE unique que le dépôt SQL reproduit.
// Trois statuts distincts, jamais un `statut=` ambigu. Les états d'instance sont recopiés ici (le catalogue ne touche aucun schéma de client) ; un test du dépôt SQL les compare à l'énumération de la base.
export const STATUTS_INSTANCE = ["active", "pause", "erreur", "livree"] as const;
export const TRIS = ["nom", "clients", "temps_gagne", "derniere_version"] as const;
export type Tri = (typeof TRIS)[number];
export type Ordre = "asc" | "desc";

export interface LigneCatalogue {
  id: string;
  code: string;
  nom: string;
  metiers: string[];
  postes: string[];
  outils: string[];
  statut_automatisation: string;
  nb_clients: number;
  minutes_gagnees: number | null;
  derniere_version_le: string | null;
}
export interface Curseur { tri: Tri; ordre: Ordre; v: string | number | null; id: string }
export interface FiltresCatalogue {
  metier: string[]; poste: string[]; outil: string[];
  statut_automatisation: string[]; statut_version: string[]; statut_instance: string[]; visibilite: string[];
  tri: Tri; ordre: Ordre; limite: number; curseur: Curseur | undefined;
}

const MAX_VALEURS = 20;
const bad = () => new ErreurApi("schema_invalide", "Requête invalide.");
const inconnue = () => new ErreurApi("regle_metier", "Valeur de filtre inconnue.");
const Brut = z.strictObject({
  metier: z.string().max(1500).optional(), poste: z.string().max(1500).optional(), outil: z.string().max(1500).optional(),
  statut_automatisation: z.string().max(200).optional(), statut_version: z.string().max(200).optional(), statut_instance: z.string().max(200).optional(), visibilite: z.string().max(200).optional(),
  tri: z.string().max(30).optional(), ordre: z.string().max(4).optional(), limite: z.string().regex(/^[0-9]{1,3}$/).optional(), curseur: z.string().max(512).optional(),
});
const SLUG = /^[a-z0-9_-]{1,64}$/;
const liste = (brut: string | undefined, permis?: readonly string[]): string[] => {
  if (brut === undefined || brut === "") return [];
  const valeurs = [...new Set(brut.split(","))];
  if (valeurs.length > MAX_VALEURS) throw bad();
  for (const v of valeurs) {
    if (!SLUG.test(v)) throw bad();
    if (permis && !permis.includes(v)) throw inconnue();
  }
  return valeurs;
};

const valeurDe = (l: LigneCatalogue, tri: Tri): string | number | null =>
  tri === "nom" ? l.nom : tri === "clients" ? l.nb_clients : tri === "temps_gagne" ? l.minutes_gagnees : l.derniere_version_le;
export const valeurDeTri = valeurDe;

// Ordre unique : valeur de tri (les valeurs nulles TOUJOURS en dernier, dans les deux sens), puis identifiant croissant (départage stable).
export function comparer(a: LigneCatalogue, b: LigneCatalogue, tri: Tri, ordre: Ordre): number {
  const x = valeurDe(a, tri), y = valeurDe(b, tri);
  if (x === null || y === null) {
    if (x !== y) return x === null ? 1 : -1;
  } else if (x !== y) {
    const sens = x < y ? -1 : 1;
    return ordre === "asc" ? sens : -sens;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export const encoderCurseur = (c: Curseur): string => Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
const SchemaCurseur = z.strictObject({ tri: z.enum(TRIS), ordre: z.enum(["asc", "desc"]), v: z.union([z.string().max(200), z.number().finite(), z.null()]), id: z.uuid() });
export function decoderCurseur(brut: string, tri: Tri, ordre: Ordre): Curseur {
  if (brut.length > 512 || !/^[A-Za-z0-9_-]+$/.test(brut)) throw bad();
  let valeur: unknown;
  try { valeur = JSON.parse(Buffer.from(brut, "base64url").toString("utf8")); } catch { throw bad(); }
  const r = SchemaCurseur.safeParse(valeur);
  if (!r.success || r.data.tri !== tri || r.data.ordre !== ordre) throw bad();
  return r.data;
}

export function analyserFiltres(query: unknown): FiltresCatalogue {
  const p = Brut.safeParse(query ?? {});
  if (!p.success) throw bad();
  const q = p.data;
  const tri = q.tri === undefined ? "nom" : (TRIS as readonly string[]).includes(q.tri) ? (q.tri as Tri) : (() => { throw inconnue(); })();
  const ordre: Ordre = q.ordre === undefined || q.ordre === "asc" ? "asc" : q.ordre === "desc" ? "desc" : (() => { throw inconnue(); })();
  const limite = q.limite === undefined ? 25 : Number(q.limite);
  if (limite < 1 || limite > 100) throw bad();
  return {
    metier: liste(q.metier), poste: liste(q.poste), outil: liste(q.outil),
    statut_automatisation: liste(q.statut_automatisation, statutAutomatisation.enumValues),
    statut_version: liste(q.statut_version, statutVersion.enumValues),
    statut_instance: liste(q.statut_instance, STATUTS_INSTANCE),
    visibilite: liste(q.visibilite, visibiliteAutomatisation.enumValues),
    tri, ordre, limite,
    curseur: q.curseur === undefined || q.curseur === "" ? undefined : decoderCurseur(q.curseur, tri, ordre),
  };
}
