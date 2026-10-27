import type { ZodType } from "zod";
import type { RouteContrat } from "../commun/routes.ts";
import * as s from "./schemas.ts";

export const PREFIXE_C1 = "/api/console/v1";

export interface RouteC1 extends RouteContrat {
  // Corps (POST) ou requête (GET) ; absent quand la route n'a ni l'un ni l'autre.
  requete?: ZodType;
  // Réponse par statut HTTP de succès.
  reponses: Record<number, ZodType>;
}

const ecriture = { methode: "POST", limite: "c1", antiDoublon: "idempotency_key" } as const;
const lecture = { methode: "GET", limite: "c1", antiDoublon: "lecture" } as const;

// 9 routes : les 8 de l'annexe + le rattrapage de C2. Aucune route de pause ni de modification de plan.
// Toute autre route : 403 action_interdite. Chaque écriture exige Idempotency-Key ; toutes partagent la limite de C1.
export const ROUTES_C1 = {
  "clients-retrouver-ou-creer": { ...ecriture, chemin: "/clients/retrouver-ou-creer", requete: s.RetrouverOuCreerRequete, reponses: { 200: s.RetrouverOuCreerReponse200, 202: s.RetrouverOuCreerReponse202 } },
  "clients-statut": { ...ecriture, chemin: "/clients/{axiCli}/statut", requete: s.StatutRequete, reponses: { 200: s.StatutReponse } },
  devis: { ...ecriture, chemin: "/devis", requete: s.DevisRequete, reponses: { 201: s.DevisReponse } },
  "plans-recurrents": { ...ecriture, chemin: "/plans-recurrents", requete: s.PlanRequete, reponses: { 201: s.PlanReponse } },
  "plans-recurrents-clore": { ...ecriture, chemin: "/plans-recurrents/{idPlan}/clore", requete: s.CloreRequete, reponses: { 200: s.CloreReponse } },
  "factures-ponctuelles": { ...ecriture, chemin: "/factures-ponctuelles", requete: s.FacturePonctuelleRequete, reponses: { 201: s.FacturePonctuelleReponse } },
  statuts: { ...lecture, chemin: "/statuts", requete: s.StatutsRequete, reponses: { 200: s.StatutsReponse } },
  "clients-apporteurs": { ...lecture, chemin: "/clients/{axiCli}/apporteurs", reponses: { 200: s.ApporteursReponse } },
  faits: { ...lecture, chemin: "/faits", requete: s.RattrapageRequete, reponses: { 200: s.RattrapageReponse } },
} as const satisfies Record<string, RouteC1>;
