import { z } from "zod";
import { Adresse, Siren, Siret, Texte } from "../commun/identifiants.ts";
import type { RouteContrat } from "../commun/routes.ts";

// SIREN, SIRET et adresse : formes communes (src/commun/identifiants.ts), réexportées pour les appelants de C3.
export { Adresse, Siren, Siret };

// Routes de C3, signées (un secret par sens). Les événements poussés se dédoublonnent par event_id (ADR 0031).
export const ROUTES_C3 = {
  // Le CRM pousse vers l'API de la console.
  crmVersConsole: { methode: "POST", chemin: "/api/crm/v1/evenements", limite: "c3_crm_vers_console", antiDoublon: "event_id" },
  // La console pousse vers le CRM.
  consoleVersCrm: { methode: "POST", chemin: "/api/console/v1/evenements", limite: "c3_console_vers_crm", antiDoublon: "event_id" },
  // Lecture d'une entreprise du CRM : ?siren= ou ?siret= (exactement un des deux).
  lecture: { methode: "GET", chemin: "/api/console/v1/entreprises", limite: "c3_lecture", antiDoublon: "lecture" },
} as const satisfies Record<string, RouteContrat>;
export const CHEMIN_LECTURE = ROUTES_C3.lecture.chemin;

export const LectureRequete = z.union([z.strictObject({ siren: Siren }), z.strictObject({ siret: Siret })]);
// Les champs foreign_id et external_ref du CRM ne font pas partie du contrat : le schéma strict les refuse.
export const LectureReponse = z.strictObject({
  crmCompanyId: Texte,
  raisonSociale: Texte,
  adresse: Adresse,
  siretEtablissement: Siret,
  // Présent seulement pour une fiche absorbée : identifiant de la fiche gardée (200, pas 404).
  absorbeePar: Texte.optional(),
});
export type LectureReponse = z.infer<typeof LectureReponse>;
