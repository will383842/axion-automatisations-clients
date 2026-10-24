import { z } from "zod";

// Codes fermés et statut HTTP de chacun (annexe A, section 0).
export const STATUT_PAR_CODE = {
  schema_invalide: 400,
  signature_invalide: 401,
  horodatage_perime: 401,
  rejeu: 401,
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

export const ErreurSchema = z.object({
  erreur: z.object({ code: CodeErreurSchema, message: z.string(), id_trace: z.string() }),
});
