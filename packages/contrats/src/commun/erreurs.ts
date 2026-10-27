import { z } from "zod";

// Codes fermés et statut HTTP de chacun (annexe A, section 0 ; `reauthentification_requise` : ADR 0024, accepté par l'ADR 0031).
export const STATUT_PAR_CODE = {
  schema_invalide: 400,
  signature_invalide: 401,
  horodatage_perime: 401,
  rejeu: 401,
  reauthentification_requise: 401,
  action_interdite: 403,
  introuvable: 404,
  cle_reutilisee: 409,
  identifiant_deja_pris: 409,
  fiche_absorbee: 422,
  regle_metier: 422,
  tva_interdite: 422,
  debit_depasse: 429,
  porte_fermee: 503,
  erreur_interne: 500,
} as const;

export type CodeErreur = keyof typeof STATUT_PAR_CODE;

export const CodeErreurSchema = z.enum(Object.keys(STATUT_PAR_CODE) as [CodeErreur, ...CodeErreur[]]);

// `motif` : code fermé facultatif qui précise `regle_metier` (par exemple `fonction_non_permise`) ; jamais un texte libre.
export const ErreurSchema = z.strictObject({
  erreur: z.strictObject({ code: CodeErreurSchema, message: z.string(), id_trace: z.string(), motif: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/).optional() }),
});
