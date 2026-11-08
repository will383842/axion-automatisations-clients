// Croisement des outils d'un client avec le catalogue des automatisations (T3-17b) : fonction pure, aucune lecture, aucune écriture.
// Le catalogue des connecteurs fait foi ; la colonne connecteur_disponible des outils du client est ignorée (ADR 0133).
// Les raisons sont des codes fermés : le texte affiché est écrit par la console, jamais repris du catalogue.
export type Gamme = "standard" | "avance" | null;
export interface EntreeCalcul {
  outils: readonly { famille: string; outil: string }[];
  catalogue: readonly { code: string; nom: string; familles: readonly string[] }[];
  connecteurs: readonly { famille: string; outil: string }[];
  gammes: Readonly<Record<string, Gamme>>;
}
export type RaisonCode = "famille_sans_outil" | "connecteur_absent" | "familles_couvertes" | "aucune_connexion";
export interface Raison { code: RaisonCode; famille: string | null; outil?: string }
export interface Evaluation {
  code: string;
  nom: string;
  raison: Raison;
  fiche: { famille: string; outils_compatibles: string[] }[];
  gamme_conseillee: Gamme;
}
export interface Compatibilite { compatibles: Evaluation[]; a_creer: Evaluation[]; impossibles: Evaluation[] }

const trier = (l: Iterable<string>): string[] => [...new Set(l)].sort();
const parCode = (a: Evaluation, b: Evaluation): number => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);

export function calculer(e: EntreeCalcul): Compatibilite {
  const sortie: Compatibilite = { compatibles: [], a_creer: [], impossibles: [] };
  for (const auto of e.catalogue) {
    const familles = trier(auto.familles);
    const fiche = familles.map((famille) => ({ famille, outils_compatibles: trier(e.connecteurs.filter((c) => c.famille === famille).map((c) => c.outil)) }));
    let impossible: Raison | null = null;
    let aCreer: Raison | null = null;
    for (const famille of familles) {
      const outils = trier(e.outils.filter((o) => o.famille === famille).map((o) => o.outil));
      if (outils.length === 0) impossible ??= { code: "famille_sans_outil", famille };
      else if (!outils.some((o) => e.connecteurs.some((c) => c.famille === famille && c.outil === o))) aCreer ??= { code: "connecteur_absent", famille, outil: outils[0] as string };
    }
    const raison: Raison = impossible ?? aCreer ?? (familles.length === 0 ? { code: "aucune_connexion", famille: null } : { code: "familles_couvertes", famille: null });
    const gamme = e.gammes[auto.code];
    const ev: Evaluation = { code: auto.code, nom: auto.nom, raison, fiche, gamme_conseillee: gamme === "standard" || gamme === "avance" ? gamme : null };
    (impossible ? sortie.impossibles : aCreer ? sortie.a_creer : sortie.compatibles).push(ev);
  }
  sortie.compatibles.sort(parCode);
  sortie.a_creer.sort(parCode);
  sortie.impossibles.sort(parCode);
  return sortie;
}
