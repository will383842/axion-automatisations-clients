import { ErreurApi } from "../plugins/erreurs.js";

// Formule d'une instance (B-312, ADR 0125) : seule « abonnement » est proposée en V1. Le refus est dans le code, jamais dans un CHECK de la base
// (une contrainte « formule = abonnement » devrait être retirée en V2, et un retrait de contrainte est interdit).
export const FORMULES_V1 = ["abonnement"] as const;
const FORMULES_CONNUES = ["abonnement", "achat", "installation_maintenance"] as const;

export function verifierFormule(formule: unknown): "abonnement" {
  if (formule === "abonnement") return formule;
  if ((FORMULES_CONNUES as readonly unknown[]).includes(formule)) throw new ErreurApi("regle_metier", "Seule la formule abonnement est proposée pour le moment.");
  throw new ErreurApi("schema_invalide", "Formule inconnue.");
}
