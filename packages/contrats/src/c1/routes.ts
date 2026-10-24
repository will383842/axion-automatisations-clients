import type { ZodType } from "zod";
import * as s from "./schemas.ts";

export const PREFIXE_C1 = "/api/console/v1";

export interface RouteC1 {
  methode: "GET" | "POST";
  chemin: string;
  // Corps (POST) ou requête (GET) ; absent quand la route n'a ni l'un ni l'autre.
  requete?: ZodType;
  // Réponse par statut HTTP de succès.
  reponses: Record<number, ZodType>;
}

// 9 routes : les 8 de l'annexe + le rattrapage de C2. Aucune route de pause ni de modification de plan.
// Toute autre route : 403 action_interdite.
export const ROUTES_C1 = {
  "clients-retrouver-ou-creer": { methode: "POST", chemin: "/clients/retrouver-ou-creer", requete: s.RetrouverOuCreerRequete, reponses: { 200: s.RetrouverOuCreerReponse, 202: s.RetrouverOuCreerReponse } },
  "clients-statut": { methode: "POST", chemin: "/clients/{axiCli}/statut", requete: s.StatutRequete, reponses: { 200: s.StatutReponse } },
  devis: { methode: "POST", chemin: "/devis", requete: s.DevisRequete, reponses: { 201: s.DevisReponse } },
  "plans-recurrents": { methode: "POST", chemin: "/plans-recurrents", requete: s.PlanRequete, reponses: { 201: s.PlanReponse } },
  "plans-recurrents-clore": { methode: "POST", chemin: "/plans-recurrents/{idPlan}/clore", requete: s.CloreRequete, reponses: { 200: s.CloreReponse } },
  "factures-ponctuelles": { methode: "POST", chemin: "/factures-ponctuelles", requete: s.FacturePonctuelleRequete, reponses: { 201: s.FacturePonctuelleReponse } },
  statuts: { methode: "GET", chemin: "/statuts", requete: s.StatutsRequete, reponses: { 200: s.StatutsReponse } },
  "clients-apporteurs": { methode: "GET", chemin: "/clients/{axiCli}/apporteurs", reponses: { 200: s.ApporteursReponse } },
  faits: { methode: "GET", chemin: "/faits", requete: s.RattrapageRequete, reponses: { 200: s.RattrapageReponse } },
} as const satisfies Record<string, RouteC1>;
