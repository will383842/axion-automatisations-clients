// Liste FERMÉE « rôle → routes » du portail (T6-02b). Écrite UNE fois, sans aucune importation : l'API la lit pour REFUSER, l'écran la relit pour CACHER.
// Quatre rôles, aucun « dirigeant » (repère en base, jamais un rôle du jeton). Une rubrique absente de la liste est refusée à tous.
export const ROLES_CLIENT = ["administrateur", "utilisateur", "lecture_seule", "comptable"] as const;
export type RoleClient = (typeof ROLES_CLIENT)[number];

export const RACINE_PORTAIL = "/api/portail/v1/";
const TOUS = ROLES_CLIENT;
const ADMIN: readonly RoleClient[] = ["administrateur"];
const AUCUN: readonly RoleClient[] = [];
// Décision T6-35 (peutChangerLesAbonnements) pas encore livrée : refus pour les quatre rôles.
const regle = (lecture: readonly RoleClient[], ecriture: readonly RoleClient[]) => ({ lecture, ecriture });

export const RUBRIQUES: Readonly<Record<string, { readonly lecture: readonly RoleClient[]; readonly ecriture: readonly RoleClient[] }>> = Object.freeze({
  automatisations: regle(["administrateur", "utilisateur", "lecture_seule"], ["administrateur", "utilisateur"]),
  equipe: regle(ADMIN, ADMIN),
  connexions: regle(ADMIN, ADMIN),
  export: regle(ADMIN, ADMIN),
  factures: regle(["administrateur", "comptable"], ADMIN),
  documents: regle(["administrateur", "comptable"], ADMIN),
  "mon-compte": regle(TOUS, TOUS),
  "mon-entreprise/facturation": regle(["administrateur", "comptable"], ADMIN),
  "mon-entreprise/contacts": regle(ADMIN, ADMIN),
  "fin-de-contrat": regle(ADMIN, ADMIN),
  forfaits: regle(["administrateur", "comptable"], ADMIN),
  "montee-en-ligne": regle(AUCUN, AUCUN),
  "equipe/droits-abonnement": regle(AUCUN, AUCUN),
});

// Seules routes en POST qui LISENT (une entrée) : elles suivent la règle de lecture.
export const LECTURE_EN_POST: readonly string[] = Object.freeze([`POST ${RACINE_PORTAIL}automatisations/:instance/donnees/:nom`]);

// Rubrique d'un chemin DÉCLARÉ : le plus long préfixe déclaré, sinon rien (jamais de repli).
export function rubriqueDe(cheminDeclare: string): string | undefined {
  if (!cheminDeclare.startsWith(RACINE_PORTAIL)) return undefined;
  const reste = cheminDeclare.slice(RACINE_PORTAIL.length).split("?")[0] ?? "";
  const segments = reste.split("/");
  for (let n = Math.min(segments.length, 2); n >= 1; n--) {
    const cle = segments.slice(0, n).join("/");
    if (Object.hasOwn(RUBRIQUES, cle)) return cle;
  }
  return undefined;
}

export function regleDeclaree(methode: string, cheminDeclare: string): boolean {
  return methode.length > 0 && rubriqueDe(cheminDeclare) !== undefined;
}

export function autorise(role: string, methode: string, cheminDeclare: string): boolean {
  const rub = rubriqueDe(cheminDeclare);
  if (!rub || !ROLES_CLIENT.includes(role as RoleClient)) return false;
  const m = methode.toUpperCase();
  const ecriture = !(m === "GET" || m === "HEAD") && !LECTURE_EN_POST.includes(`${m} ${cheminDeclare}`);
  const r = RUBRIQUES[rub];
  return (ecriture ? r?.ecriture : r?.lecture)?.includes(role as RoleClient) ?? false;
}

export function rubriquesLisibles(role: string): string[] {
  return Object.keys(RUBRIQUES).filter((k) => RUBRIQUES[k]?.lecture.includes(role as RoleClient));
}
