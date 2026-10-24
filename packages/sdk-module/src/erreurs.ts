// Mêmes classes que dans packages/contrats/src/c4 : le SDK ne dépend que de zod.
export const CLASSES_ERREUR = ["passagere", "quota", "identification", "definitive"] as const;
export type ClasseErreur = (typeof CLASSES_ERREUR)[number];

export const POLITIQUES = {
  passagere: { essais: 5, attente: "croissante_avec_alea" },
  quota: { attente: "date_de_l_outil" },
  identification: { connexion: "rouge", instance: "pause" },
  definitive: { evenement: "erreur" },
} as const;
