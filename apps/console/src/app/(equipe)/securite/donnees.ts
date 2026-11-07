// Formes de l'écran Sécurité et accès (T3-07d). Elles suivent les réponses prévues des routes de sessions (T3-07b) : champs fermés,
// aucune clé brute de Keycloak, aucune adresse IP. Tant que le pont console → API d'équipe n'existe pas (dette T3-07-dette-pont-console),
// la page ne reçoit pas de données réelles : elle lit un port qui rend « vide ».
export type RoleEquipe = "dirigeant" | "second_administrateur";
export type TypeFacteur = "otp" | "webauthn";

export interface SessionMembre {
  id: string;
  ouverteLe: string;
  derniereActivite: string;
  finPrevue: string;
  facteurs: readonly TypeFacteur[];
}

export interface MembreSecurite {
  id: string;
  libelle: string;
  role: RoleEquipe;
  sessions: readonly SessionMembre[];
}

export interface AccesEnCours {
  type: "vue_client" | "intervention";
  clientLibelle: string;
  debut: string;
  fin: string;
}

export type DonneesSecurite =
  | { genre: "normal"; membres: readonly MembreSecurite[]; acces: readonly AccesEnCours[] }
  | { genre: "vide" }
  | { genre: "chargement" }
  | { genre: "erreur" }
  | { genre: "acces-refuse" };

/** Port de données de l'écran : l'adaptateur réel (jeton d'accès, réauthentification, appel asynchrone) est une dette ; il remplacera cette lecture. */
export interface PortSecurite {
  lire(): DonneesSecurite;
}

/** Port par défaut : pas de pont, donc aucune donnée. */
export const portSansPont: PortSecurite = { lire: () => ({ genre: "vide" }) };
