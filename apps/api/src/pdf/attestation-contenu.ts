// Texte et contenu des attestations de fin de contrat (A-258, C-715, B-168). Modèle NEUTRE du dépôt public : le texte relu par le juriste vient de la configuration de production.
// Le texte de la mise à l'écart est celui de la fiche T2-46, À VALIDER PAR WILL à la relecture finale. Il dit que rien n'a été effacé : jamais « supprimé » ni « détruit » (A-258).
export type NatureAttestation = "mise_a_l_ecart" | "effacement";
export const OBJETS_GARDES = ["base", "compartiment", "sauvegardes", "cle_client", "identifiants", "cle_ia"] as const;
export const OBJETS_EFFACES = [...OBJETS_GARDES, "coffre", "roles"] as const;
export type TypeObjet = (typeof OBJETS_EFFACES)[number];

const LIBELLES: Record<NatureAttestation, Record<TypeObjet, string>> = {
  mise_a_l_ecart: {
    base: "Base de données du client (gardée à l'écart)", compartiment: "Compartiment de fichiers (gardé en lecture seule)", sauvegardes: "Sauvegardes (gardées)",
    cle_client: "Clé de chiffrement du client (conservée)", identifiants: "Identifiants d'accès du client (désactivés)", cle_ia: "Clé d'IA du client (désactivée et conservée)",
    coffre: "Secrets du client (gardés)", roles: "Rôles de base de données du client (gardés)",
  },
  effacement: {
    base: "Base de données du client (effacée)", compartiment: "Compartiment de fichiers (effacé)", sauvegardes: "Sauvegardes (rendues illisibles)",
    cle_client: "Clé de chiffrement du client (effacée)", identifiants: "Identifiants d'accès du client (effacés)", cle_ia: "Clé d'IA du client (effacée)",
    coffre: "Secrets du client dans le coffre (effacés)", roles: "Rôles de base de données du client (effacés)",
  },
};

export interface ObjetCompteRendu { type: string; date: Date; empreinte: string }
export interface PieceGardee { libelle: string; dureeMinimale: string }
export interface LigneAttestation { libelle: string; date: string; empreinte: string }
export interface ContenuAttestation {
  nature: NatureAttestation;
  titre: string;
  identifiantConsole: string;
  raisonSociale: string;
  objets: LigneAttestation[];
  paragraphes: string[];
  pieces: PieceGardee[];
  signataire: string;
  emisLe: string;
}
export interface EntreeContenu {
  nature: NatureAttestation;
  identifiantConsole: string;
  raisonSociale: string;
  dateFin: string;
  delaiPropositionMois: number;
  objets: ObjetCompteRendu[];
  pieces: PieceGardee[];
  signataire: string;
  emisLe: Date;
  avisClientLe: Date | null;
}
const jour = (d: Date): string => d.toISOString().slice(0, 10);

function paragraphes(e: EntreeContenu): string[] {
  if (e.nature === "mise_a_l_ecart") {
    return [
      `Votre contrat s'est terminé le ${e.dateFin}. Rien n'a été effacé : vos données de travail sont gardées à l'écart, inaccessibles, et exportables sur demande.`,
      `Elles sont gardées jusqu'à un effacement, qui a lieu plus tôt sur votre demande écrite, ou à la proposition de suppression que nous vous annoncerons au moins 30 jours avant, ${e.delaiPropositionMois} mois après la fin du contrat. Dans tous les cas, il suit une décision d'AXION IA tracée.`,
      "Vous pouvez demander l'effacement plus tôt : nous ne pouvons le refuser que pour un litige en cours ou une obligation légale.",
      "Les pièces listées plus bas sont gardées sans date de suppression, au moins pendant leur durée minimale.",
    ];
  }
  return [
    `Sur décision d'AXION IA, les objets ci-dessous ont été effacés pour votre compte. L'avis de proposition a été envoyé au client le ${e.avisClientLe ? jour(e.avisClientLe) : "(sans objet : demande écrite du client)"}.`,
    "Les sauvegardes déjà faites deviennent illisibles sur leur support, car la clé du client est effacée ; elles sont retirées à leur échéance normale.",
    "Restent gardés : le journal d'audit et les pièces listées plus bas, au moins pendant leur durée minimale.",
  ];
}

export function composerContenu(e: EntreeContenu): ContenuAttestation {
  return {
    nature: e.nature,
    titre: e.nature === "mise_a_l_ecart" ? "Attestation de mise à l'écart" : "Attestation d'effacement",
    identifiantConsole: e.identifiantConsole,
    raisonSociale: e.raisonSociale,
    objets: e.objets.map((o) => ({ libelle: LIBELLES[e.nature][o.type as TypeObjet] ?? o.type, date: jour(o.date), empreinte: o.empreinte })),
    paragraphes: paragraphes(e),
    pieces: e.pieces,
    signataire: e.signataire,
    emisLe: jour(e.emisLe),
  };
}

// Tout le texte affiché, pour les contrôles (mots interdits, mentions obligatoires).
export const texteDe = (c: ContenuAttestation): string =>
  [c.titre, c.identifiantConsole, c.raisonSociale, ...c.objets.flatMap((o) => [o.libelle, o.date, o.empreinte]), ...c.paragraphes, ...c.pieces.flatMap((p) => [p.libelle, p.dureeMinimale]), c.signataire, c.emisLe].join("\n");
