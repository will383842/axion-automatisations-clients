import { z } from "zod";
import type { Requete } from "./liste.js";

// Premières requêtes : compter les personnes, lister les listes de prospects, état des données (T2-41).
export function premieresRequetes(): Record<string, Requete> {
  const compterPersonnes: Requete = {
    nom: "compterPersonnes",
    schema: z.object({}),
    sql: "SELECT count(*)::int AS total FROM commun.personnes WHERE {{filtre}}",
    mode: "lecture",
    metadonnees: true,
    parEtablissement: true,
    colonnes: ["total"],
    valeurs: () => [],
  };
  const Lister = z.object({ limite: z.number().int().min(1).max(200).default(50) });
  const listerListesProspects: Requete = {
    nom: "listerListesProspects",
    schema: Lister,
    sql: "SELECT id, nom, cree_le FROM commun.listes_prospects WHERE {{filtre}} ORDER BY cree_le DESC LIMIT $1",
    mode: "lecture",
    metadonnees: false,
    parEtablissement: true,
    colonnes: ["id", "nom", "cree_le"],
    valeurs: (p: z.infer<typeof Lister>) => [p.limite],
  };
  const etatDonnees: Requete = {
    nom: "etatDonnees",
    schema: z.object({}),
    sql: "SELECT (SELECT count(*)::int FROM commun.personnes WHERE {{filtre}}) AS personnes, (SELECT coalesce(sum(taille_octets), 0)::float8 FROM commun.index_fichiers WHERE {{filtre}}) AS taille_fichiers, (SELECT max(version) FROM version_structure) AS version_structure",
    mode: "lecture",
    metadonnees: true,
    parEtablissement: true,
    colonnes: ["personnes", "taille_fichiers", "version_structure"],
    valeurs: () => [],
  };
  return { compterPersonnes, listerListesProspects, etatDonnees };
}
