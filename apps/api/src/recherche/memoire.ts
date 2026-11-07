import { PLATEFORME_ID } from "../db/schema/aides.js";
import { SOURCES, type DepotRecherche, type LigneRecherche, type ParametresRecherche } from "./index.js";

// Dépôt en mémoire (essais) : même contrat que le SQL. Portée et plateforme sont appliquées AVANT la coupe de la limite.
export type LigneMemoire = LigneRecherche & { siren?: string };
const plat = (t: string): string => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const contient = (valeur: string | null | undefined, motif: string): boolean => valeur != null && plat(valeur).includes(plat(motif));

function correspond(l: LigneMemoire, p: ParametresRecherche): boolean {
  switch (l.type) {
    case "client": return contient(l.libelle, p.terme) || (p.siren !== null && l.siren === p.siren);
    case "contact": return contient(l.libelle, p.terme) || contient(l.email, p.terme);
    case "facture": return contient(l.libelle, p.terme);
    case "demande": return contient(l.libelle, p.terme) || (p.idDemande !== null && l.id === p.idDemande);
    case "instance": return contient(l.libelle, p.terme) || contient(l.automatisation_nom, p.terme);
  }
}
const rang = (l: LigneRecherche, terme: string): number => (plat(l.libelle) === plat(terme) ? 0 : plat(l.libelle).startsWith(plat(terme)) ? 1 : 2);

export function creerDepotMemoire(donnees: LigneMemoire[]): DepotRecherche & { appels: number } {
  const depot = {
    appels: 0,
    async chercher(p: ParametresRecherche): Promise<LigneRecherche[]> {
      depot.appels++;
      return SOURCES.flatMap((type) =>
        donnees
          .filter((l) => l.type === type && l.client_id !== PLATEFORME_ID && (p.tous || p.clients.includes(l.client_id)) && correspond(l, p))
          .sort((a, b) => rang(a, p.terme) - rang(b, p.terme) || a.libelle.localeCompare(b.libelle) || a.id.localeCompare(b.id))
          .slice(0, p.limite)
          .map((l) => { const { siren, ...ligne } = l; void siren; return ligne as LigneRecherche; }),
      );
    },
  };
  return depot;
}
