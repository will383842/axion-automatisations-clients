import { z } from "zod";
import { CONTROLE, echapperLike } from "../recherche/index.js";
import { ErreurApi } from "../plugins/erreurs.js";
import { proches, type CandidatDoublon, type Proche } from "./doublons.js";
import { analyserFiltres, encoderCurseur, valeurDeTri, type FiltresCatalogue, type LigneCatalogue } from "./filtres.js";

// Service du catalogue (T3-40a, B-532, B-533, B-534) : métadonnées du catalogue seulement, jamais un contenu de client ni une base de client.
export interface Synonyme { mot: string; equivalent: string }
export interface DepotCatalogue {
  // Au plus `taille` lignes, après filtres, tri et curseur appliqués EN BASE.
  lister(filtres: FiltresCatalogue, taille: number): Promise<LigneCatalogue[]>;
  // `termes` normalisés, `motifs` = les mêmes, échappés pour LIKE ; la base ignore accents et casse.
  chercher(termes: string[], motifs: string[]): Promise<LigneCatalogue[]>;
  synonymes(): Promise<Synonyme[]>;
  ajouterSynonyme(mot: string, equivalent: string, acteur: string): Promise<void>;
  // Candidats au doublon : au plus 200 automatisations du catalogue.
  candidats(): Promise<LigneCatalogue[]>;
}

const bad = () => new ErreurApi("schema_invalide", "Requête invalide.");
// Sans accent, sans casse, espaces réduits : « Préréglage » et « prereglage » donnent le même terme.
export const normaliser = (texte: string): string => texte.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim().replace(/\s+/g, " ");

const Recherche = z.strictObject({ q: z.string().max(200) });
const Synonymes = z.strictObject({ mot: z.string().max(200), equivalent: z.string().max(200) });
const Liste = z.string().max(1500).optional();
const Doublons = z.strictObject({ nom: z.string().max(300), poste: Liste, metier: Liste, outil: Liste });
const lire = <T>(schema: z.ZodType<T>, valeur: unknown): T => {
  const r = schema.safeParse(valeur ?? {});
  if (!r.success) throw bad();
  return r.data;
};
function terme(brut: string, min: number, max: number): string {
  if (CONTROLE.test(brut)) throw bad();
  const t = normaliser(brut);
  const n = [...t].length;
  if (n < min || n > max) throw bad();
  return t;
}
const etiquettes = (brut: string | undefined): string[] => (brut ?? "").split(",").map((e) => e.trim().toLowerCase()).filter((e) => /^[a-z0-9_-]{1,64}$/.test(e)).slice(0, 20);

export function creerServiceCatalogue(depot: DepotCatalogue) {
  return {
    async lister(query: unknown): Promise<{ automatisations: LigneCatalogue[]; curseur_suivant: string | null }> {
      const f = analyserFiltres(query);
      const lues = await depot.lister(f, f.limite + 1);
      const page = lues.slice(0, f.limite);
      const dernier = page[page.length - 1];
      const suite = lues.length > f.limite && dernier !== undefined;
      return { automatisations: page, curseur_suivant: suite ? encoderCurseur({ tri: f.tri, ordre: f.ordre, v: valeurDeTri(dernier, f.tri), id: dernier.id }) : null };
    },
    async rechercher(query: unknown): Promise<{ automatisations: LigneCatalogue[] }> {
      const t = terme(lire(Recherche, query).q, 2, 100);
      // Synonymes dans les deux sens, mot entier seulement ; au plus 10 termes cherchés.
      const mots = new Set(t.split(" "));
      const termes = new Set([t]);
      for (const s of await depot.synonymes()) {
        const a = normaliser(s.mot), b = normaliser(s.equivalent);
        if (mots.has(a)) termes.add(b);
        if (mots.has(b)) termes.add(a);
      }
      const liste = [...termes].slice(0, 10);
      return { automatisations: await depot.chercher(liste, liste.map(echapperLike)) };
    },
    async doublons(query: unknown): Promise<{ bloquant: false; proches: Proche[] }> {
      const q = lire(Doublons, query);
      const candidat: CandidatDoublon = { nom: terme(q.nom, 2, 120), postes: etiquettes(q.poste), metiers: etiquettes(q.metier), outils: etiquettes(q.outil) };
      return { bloquant: false, proches: proches(candidat, await depot.candidats()) };
    },
    async ecrireSynonyme(corps: unknown, acteur: string): Promise<Synonyme> {
      if (acteur.trim() === "") throw bad();
      const c = lire(Synonymes, corps);
      const mot = terme(c.mot, 2, 60), equivalent = terme(c.equivalent, 2, 60);
      if (mot === equivalent) throw new ErreurApi("regle_metier", "Deux mots identiques ne sont pas des synonymes.");
      await depot.ajouterSynonyme(mot, equivalent, acteur);
      return { mot, equivalent };
    },
  };
}
export type ServiceCatalogue = ReturnType<typeof creerServiceCatalogue>;
