// Matrice unique « rôle × action » (T3-06). Liste FERMÉE : tout ce qui n'y figure pas est refusé. La V1 n'a que deux rôles (« membre de l'équipe » n'existe pas, C-663).
// Les rôles de Keycloak disent qui est la personne ; ce fichier décide de ce qu'elle peut faire. Aucun droit ne se lit depuis le navigateur.
export const ROLES = ["dirigeant", "second_administrateur"] as const;
export type Role = (typeof ROLES)[number];

export const ARGENT = ["emettre_facture", "annuler_facture", "avoir", "encaissement", "fin_de_contrat", "disjoncteur"] as const;
export const ACTIONS = [
  "lire", "modifier_reglages", "relancer", "connexions_secrets", "publier_catalogue", "utilisateurs_roles", "journal_complet",
  ...ARGENT, "page_etat", "voir_comme_client", "acces_urgence", "lire_base_client",
  "envoyer_notification_violation", "lever_arret_urgence",
  "ajouter_volume", "annuler_ajustement", "relever_p2", "lire_parametres_forfaits", "ecrire_parametres_forfaits",
] as const;
export type Action = (typeof ACTIONS)[number];

export interface ContexteDroit {
  absenceOuverte?: boolean; // absence de Will en cours : lue à chaque requête par l'appelant, jamais gardée en cache
  accordClient?: boolean; // accord du client pour lire le contenu de sa base (B-109)
}

// Second administrateur (C-568) : jamais l'argent, jamais les secrets, jamais la publication, jamais les utilisateurs. PROPOSITION à faire confirmer par Will.
const SECOND: ReadonlySet<Action> = new Set<Action>(["lire", "modifier_reglages", "relancer", "lire_parametres_forfaits", "ajouter_volume", "annuler_ajustement"]);
// Droits en plus pendant une absence (C-617) : aucune action d'argent.
const SECOND_EN_ABSENCE: ReadonlySet<Action> = new Set<Action>(["envoyer_notification_violation", "lever_arret_urgence"]);
// Le dirigeant a tout, sauf ce qui demande un accord (B-109) ou une règle d'absence.
const SANS_ROLE_DIRIGEANT: ReadonlySet<Action> = new Set<Action>(["lire_base_client", "envoyer_notification_violation", "lever_arret_urgence"]);

const estAction = (a: unknown): a is Action => typeof a === "string" && (ACTIONS as readonly string[]).includes(a);

export function autorise(role: string, action: string, ctx: ContexteDroit = {}): boolean {
  if (!estAction(action)) return false;
  if (role === "dirigeant") return action === "lire_base_client" ? ctx.accordClient === true : true;
  if (role !== "second_administrateur" || SANS_ROLE_DIRIGEANT.has(action) && !SECOND_EN_ABSENCE.has(action)) return false;
  if ((ARGENT as readonly string[]).includes(action)) return false;
  return SECOND.has(action) || (ctx.absenceOuverte === true && SECOND_EN_ABSENCE.has(action));
}

// ajouter_volume : le second administrateur, un client à la fois, jusqu'à P1 cumulé par instance et par mois ; P1 indéfini (null) : dirigeant seul.
export function autoriseVolume(role: string, v: { p1: number | null; cumulMois: number; ajout: number; clients: number }): boolean {
  if (role === "dirigeant") return true;
  if (role !== "second_administrateur" || v.p1 === null) return false;
  return v.clients === 1 && Number.isFinite(v.ajout) && v.ajout > 0 && v.cumulMois + v.ajout <= v.p1;
}

// annuler_ajustement : l'auteur ou un dirigeant (la réauthentification est posée par la route).
export function peutAnnulerAjustement(role: string, o: { auteur: string; acteur: string }): boolean {
  return role === "dirigeant" || (role === "second_administrateur" && o.auteur === o.acteur);
}

// Changement d'un membre : jamais son propre rôle ni sa propre portée, jamais le retrait du dernier dirigeant, et seulement par un dirigeant (utilisateurs_roles).
export function changementMembreAutorise(o: {
  acteur: { sujet: string; role: string };
  cible: { sujet: string; role: string };
  nouveau: { role?: string; portee?: string[] } | "retrait";
  dirigeantsActifs: number;
}): boolean {
  if (!autorise(o.acteur.role, "utilisateurs_roles")) return false;
  if (o.acteur.sujet === o.cible.sujet) return false;
  if (o.nouveau === "retrait" && o.cible.role === "dirigeant" && o.dirigeantsActifs <= 1) return false;
  return true;
}

// Action de chaque route de la console (garde scripts/garde-droits.ts). La route « entrée » est exemptée par la garde, avec sa raison.
export const ACTION_PAR_ROUTE: Readonly<Record<string, Action>> = {
  "POST /api/console/v1/a-trancher/:id/appliquer": "modifier_reglages",
  "POST /api/console/v1/a-trancher/:id/ecarter": "modifier_reglages",
  "GET /api/console/v1/canaux/echecs": "lire",
  "POST /api/console/v1/canaux/echecs/:tenantId/:id/renvoyer": "relancer",
  "POST /api/console/v1/clients/:id/base/reprendre": "relancer",
  // T4-28b1 : déploiement d'une instance (routes fermées par défaut). Action provisoire « modifier_reglages » ; une action dédiée reste à décider (dette T4-28b1-dette-matrice-droits).
  "POST /api/console/v1/clients/:tenantId/instances": "modifier_reglages",
  "POST /api/console/v1/clients/:tenantId/instances/:id/activation": "modifier_reglages",
  "POST /api/console/v1/clients/:tenantId/instances/:id/tests-a-blanc": "modifier_reglages",
  "GET /api/console/v1/clients/:id/fiche": "lire",
  "GET /api/console/v1/clients/:id/gel": "lire",
  "GET /api/console/v1/clients/:id/notes": "lire",
  "GET /api/console/v1/clients/:id/outils": "lire",
  "POST /api/console/v1/clients/:id/notes": "modifier_reglages",
  "POST /api/console/v1/clients/:id/notes/:idNote/epingler": "modifier_reglages",
  "POST /api/console/v1/clients/:id/notes/appel-et-cloture": "modifier_reglages",
  "POST /api/console/v1/clients/:id/gel": "disjoncteur",
  "POST /api/console/v1/clients/:id/gel/:idGel/lever": "disjoncteur",
  "POST /api/console/v1/instances/:id/reglages": "modifier_reglages",
  "POST /api/console/v1/instances/:id/reglages/revenir": "modifier_reglages",
  "GET /api/console/v1/instances/:id/reglages/versions": "lire",
  "POST /api/console/v1/journal/:id/annuler": "modifier_reglages",
  "GET /equipe/journal": "journal_complet",
};
